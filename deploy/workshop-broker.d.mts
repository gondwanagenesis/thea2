// Types for the one pure piece of the workshop broker the hermetic suite tests (F2).
export interface WorkshopChange {
  status: string;
  path: string;
  from?: string;
}
/** undefined = the change may go on; a string = why it may not. */
export function f2(changes: WorkshopChange[], diffText: string, secrets?: string[]): string | undefined;
