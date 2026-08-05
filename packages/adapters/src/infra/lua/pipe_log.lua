-- pipe_log.lua
-- Push request log into shared dict queue log_pipe:q:{host} for /stream SSE.
-- Payload shape matches requestLogger.js (id, ip, country when known,
-- timestamp, date, uri, method, status, userAgent, requestSize, responseSize,
-- responseTime).
--
-- Called via ngx.timer.at from site_logger (premature is first arg).

local cjson = require "cjson.safe"

local SUB_PREFIX   = "log_pipe:sub:"
local QUEUE_PREFIX = "log_pipe:q:"
local QUEUE_MAX_LEN = 2000

-- SAFE LOAD: GeoIP (per-worker, cached by require)
local geo_ok, geo = pcall(require, "openship.geo_country")
if not geo_ok then geo = nil end

-- Reused payload table per worker (cleared after encode to avoid GC pressure)
local payload = {}

-- `cc` is the country site_logger already resolved for this request. Passed in rather
-- than looked up again: one mmdb hit per request, and the live frame can never disagree
-- with the rollup or the ring buffer about where a hit came from.
local function pipe_request_log(premature, host, ip, ts, ua, uri,
                                req_len, bytes, rt, method, status, cc)
    if premature then return end

    local sh = ngx.shared.request_data
    if not sh then return end

    -- Double-check subscriber is still active (guard against race)
    if not sh:get(SUB_PREFIX .. host) then return end

    pcall(function()
        -- Falls back to its own lookup only if the caller passed nothing, which happens
        -- when a box is mid-deploy and still has the previous site_logger.
        local country = cc
        if (not country or country == "") and geo and geo.get_country_code then
            local ok_cc, res = pcall(geo.get_country_code, ip)
            if ok_cc then country = res end
        end

        payload.id           = string.format("%.3f-%d", ts, math.random(10000, 99999))
        payload.host         = host
        payload.ip           = ip
        if country and type(country) == "string" and country ~= "" then
            payload.country = country
        end
        payload.timestamp    = ts
        payload.date         = os.date("!%Y-%m-%d %H:%M:%S", ts)
        payload.uri          = uri
        payload.method       = method or "GET"
        payload.status       = tonumber(status) or 0
        payload.userAgent    = ua or ""
        payload.requestSize  = tonumber(req_len) or 0
        payload.responseSize = tonumber(bytes) or 0
        payload.responseTime = tonumber(rt) or 0

        local body = cjson.encode(payload)

        -- Clear payload table for next reuse
        for k in pairs(payload) do payload[k] = nil end

        if not body then return end

        local qkey = QUEUE_PREFIX .. host
        sh:lpush(qkey, body)
        if sh:llen(qkey) > QUEUE_MAX_LEN then
            sh:rpop(qkey)
        end
    end)
end

return {
    pipe_request_log = pipe_request_log,
}
