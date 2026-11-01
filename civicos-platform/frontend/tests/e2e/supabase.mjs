import { createServer } from 'node:http';

const apiKey = process.env.SUPABASE_ANON_KEY;
const corsHeaders = {
  'Access-Control-Allow-Origin': 'http://127.0.0.1:3310',
  'Access-Control-Allow-Headers': 'apikey,authorization,content-type,x-client-info,x-supabase-api-version',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
};
const respond = (response, status, body) => {
  response.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders);
    return response.end();
  }
  if (request.url === '/health') return respond(response, 200, { status: 'ok' });
  if (request.method === 'POST' && request.url?.startsWith('/auth/v1/otp')) {
    request.resume();
    return respond(response, 200, {});
  }
  if (request.method === 'GET' && request.url === '/auth/v1/user') {
    if (request.headers.apikey !== apiKey) return respond(response, 401, { message: 'Invalid API key' });
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    const payload = token?.split('.')[1];
    if (!payload) return respond(response, 401, { message: 'Invalid token' });
    try {
      const identity = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!identity.sub || !identity.email || identity.exp <= Date.now() / 1000) {
        return respond(response, 401, { message: 'Invalid token' });
      }
      return respond(response, 200, {
        id: identity.sub, email: identity.email,
        email_confirmed_at: new Date().toISOString(), confirmed_at: new Date().toISOString(),
      });
    } catch {
      return respond(response, 401, { message: 'Invalid token' });
    }
  }
  respond(response, 404, { message: 'Not found' });
}).listen(3331, '127.0.0.1');
