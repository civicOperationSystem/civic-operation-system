export async function readMapApiResponse<T>(response: Response, unavailableMessage: string): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    const reason = response.ok
      ? 'The map service returned an invalid response.'
      : `${unavailableMessage} (HTTP ${response.status}).`;
    throw new Error(reason);
  }
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
      ? body.message : `${unavailableMessage} (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return body as T;
}
