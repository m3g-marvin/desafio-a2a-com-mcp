export class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}
