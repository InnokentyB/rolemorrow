/* global Response */
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { registerMcpTools } from './mcp-tools.mjs';
export function handleMcp(req, res, options) {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'Rolemorrow', version: '1.0.0' });
      registerMcpTools(server, options);
      return server;
    },
    { legacy: 'stateless', maxRequestBodySize: 128 * 1024, responseMode: 'json' },
  );
  req.auth = {
    clientId: options.context.clientId,
    scopes: options.context.scopes,
    expiresAt: Math.floor(options.context.accessExpiresAt / 1000),
  };
  const bounded = {
    fetch: async (request, options) => {
      let message;
      try {
        message = await request.clone().json();
      } catch {}
      if (typeof message?.method === 'string' && /subscribe|subscriptions/.test(message.method))
        return Response.json(
          {
            jsonrpc: '2.0',
            id:
              typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null,
            error: { code: -32601, message: 'Subscriptions are unavailable. Use get_updates.' },
          },
          { status: 200 },
        );
      return handler.fetch(request, options);
    },
  };
  return toNodeHandler(bounded, { maxRequestBodySize: 128 * 1024 })(req, res).finally(() =>
    handler.close(),
  );
}
