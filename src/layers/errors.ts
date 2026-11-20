export class LayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayerError";
  }
}
