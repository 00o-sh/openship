import type { SystemComponentDefinition } from "./types";

export const SYSTEM_COMPONENTS: SystemComponentDefinition[] = [
  {
    name: "docker",
    label: "Docker",
    description: "Container runtime for deployments",
    installable: true,
    category: "core",
  },
  {
    name: "git",
    label: "Git",
    description: "Version control for source code",
    installable: true,
    category: "core",
  },
  {
    // ONE component for the edge, because it is ONE artifact: the openship-edge
    // image. OpenResty, its Lua, and certbot all ship inside it — they were three
    // rows in this list for a thing that is installed, checked, and removed as a
    // unit, and neither "openresty" nor "certbot" was independently installable
    // on a converted box.
    name: "edge",
    label: "Edge",
    description: "Routing + TLS — the openship-edge container (OpenResty, Lua, certbot)",
    installable: true,
    category: "infrastructure",
  },
  {
    name: "rsync",
    label: "rsync",
    description: "Fast directory sync for remote local-build transfers",
    installable: true,
    category: "infrastructure",
  },
];

export const SYSTEM_COMPONENTS_BY_NAME = new Map(
  SYSTEM_COMPONENTS.map((component) => [component.name, component]),
);

/**
 * Names that USED to be components and are now folded into one.
 *
 * A stale dashboard bundle or an older CLI still asks to install/check
 * "openresty" or "certbot" — and a cached setup-state file on any already-provisioned
 * server still has those keys. Mapping them here means the rename can't turn an
 * in-flight request into "no installer for openresty", and old state simply reads
 * as the edge.
 */
const COMPONENT_ALIASES: Record<string, string> = {
  openresty: "edge",
  certbot: "edge",
};

/** The current name for a possibly-legacy component name. */
export function canonicalComponentName(name: string): string {
  return COMPONENT_ALIASES[name] ?? name;
}

export function getSystemComponentDefinition(
  name: string,
): SystemComponentDefinition {
  return (
    SYSTEM_COMPONENTS_BY_NAME.get(name) ?? {
      name,
      label: name,
      description: `${name} component`,
      installable: false,
      category: "infrastructure" as const,
    }
  );
}