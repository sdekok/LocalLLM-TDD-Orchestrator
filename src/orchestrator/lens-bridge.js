/**
 * Build-safe bridge for pi-lens.
 * Using JS to avoid tsc's strict checking of pi-lens .ts source files.
 */
export async function getLensClients() {
  try {
    const { TypeScriptClient } = await import('pi-lens/clients/typescript-client.js');
    const { AstGrepClient } = await import('pi-lens/clients/ast-grep-client.js');
    return { TypeScriptClient, AstGrepClient };
  } catch (err) {
    throw new Error(`Failed to load pi-lens clients: ${err.message}`);
  }
}
