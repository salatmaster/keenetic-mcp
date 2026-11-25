/** Base class for every error this package raises. */
export abstract class KeeneticError extends Error {
  /** `guidance` is what the caller should do next, written for a model, not a human. */
  protected constructor(
    cause: string,
    readonly guidance: string
  ) {
    super(`${cause} ${guidance}`);
    this.name = new.target.name;
  }
}

export class AuthError extends KeeneticError {
  constructor(cause: string) {
    super(cause, 'The server cannot fix this itself - ask the user to run: npx keenetic-mcp init');
  }
}

export class TransportError extends KeeneticError {
  constructor(cause: string) {
    super(
      cause,
      'The router was unreachable. Check that the machine is on the same network ' +
        'and that KEENETIC_HOST points at the router.'
    );
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

  constructor(cause: string, details: RciErrorDetails) {
    super(
      `RCI error at ${details.path} (code ${details.code}, ${details.ident}): ${cause}.`,
      'The router rejected this command. The path may not exist on this firmware ' +
        'or the arguments may be wrong. Verify the path against get_system_info components.'
    );
    this.path = details.path;
    this.code = details.code;
    this.ident = details.ident;
  }
}

export class ValidationError extends KeeneticError {
  constructor(cause: string) {
    super(cause, 'Correct the arguments and call the tool again.');
  }
}
