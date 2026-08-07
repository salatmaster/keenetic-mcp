/** Base class for every error this package raises. */
export abstract class KeeneticError extends Error {
  /** What the caller should do next. Written for a model, not a human. */
  abstract readonly guidance: string;

  protected constructor(cause: string) {
    super(cause);
    this.name = new.target.name;
  }

  /** Called by subclasses once `guidance` is available on the instance. */
  protected finalize(cause: string): void {
    this.message = `${cause} ${this.guidance}`;
  }
}

export class AuthError extends KeeneticError {
  readonly guidance =
    'The server cannot fix this itself - ask the user to run: npx keenetic-mcp init';

  constructor(cause: string) {
    super(cause);
    this.finalize(cause);
  }
}

export class TransportError extends KeeneticError {
  readonly guidance =
    'The router was unreachable. Check that the machine is on the same network ' +
    'and that KEENETIC_HOST points at the router.';

  constructor(cause: string) {
    super(cause);
    this.finalize(cause);
  }
}

export interface RciErrorDetails {
  path: string;
  code: string;
  ident: string;
}

export class RciError extends KeeneticError {
  readonly path: string;
  readonly code: string;
  readonly ident: string;
  readonly guidance =
    'The router rejected this command. The path may not exist on this firmware ' +
    'or the arguments may be wrong. Verify the path against get_system_info components.';

  constructor(cause: string, details: RciErrorDetails) {
    super(cause);
    this.path = details.path;
    this.code = details.code;
    this.ident = details.ident;
    this.finalize(`RCI error at ${details.path} (code ${details.code}, ${details.ident}): ${cause}.`);
  }
}

export class NotSupportedError extends KeeneticError {
  readonly guidance =
    'This router does not have the required component installed. ' +
    'Call get_system_info to see the component list.';

  constructor(cause: string) {
    super(cause);
    this.finalize(cause);
  }
}

export class ValidationError extends KeeneticError {
  readonly guidance = 'Correct the arguments and call the tool again.';

  constructor(cause: string) {
    super(cause);
    this.finalize(cause);
  }
}
