export function assertStableRedeployHostPort(input: {
  sameTarget: boolean;
  serviceName: string;
  carried: number | undefined;
  allocated: number;
}): void {
  if (!input.sameTarget || input.carried === undefined || input.allocated === input.carried) return;
  throw new Error(
    `Refusing to change the locked host port for ${input.serviceName} from ${input.carried} to ${input.allocated} ` +
      `during a same-server redeploy. The existing workload and routes were left unchanged.`,
  );
}
