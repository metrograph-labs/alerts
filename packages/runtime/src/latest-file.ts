/**
 * The writer of a file that holds only the latest text, for example the use reads (AL-91) and the coverage report
 * (AL-196). It writes one text at a time, and only a text that changed.
 */

/** The options of the writer of a file of the latest text. */
export interface LatestFileOptions {
  /** This function writes the text of the file. It replaces the file in one step, for example with a write and a rename. */
  readonly write: (text: string) => Promise<void>;
  /** This function gets the error of a failed write. The next update writes the file again. */
  readonly onError: (error: unknown) => void;
}

/** The writer of a file of the latest text. */
export interface LatestFile {
  /** This method writes the text when it changed. It does not wait for the write, and it does not throw. */
  update(text: string): void;
  /** This method gives a promise that ends when no write is in progress. */
  idle(): Promise<void>;
}

/**
 * This function makes the writer of a file of the latest text. A text that comes during a write replaces the text
 * that waits, thus the last text wins. A failed write forgets the written text, thus the next update writes again.
 */
export function latestFile(options: LatestFileOptions): LatestFile {
  let written: string | undefined;
  let waiting: string | undefined;
  let running: Promise<void> | undefined;
  const start = (text: string): void => {
    running = options
      .write(text)
      .then(
        () => {
          written = text;
        },
        (error: unknown) => {
          written = undefined;
          try {
            options.onError(error);
          } catch {
            // A fault of the error handler does not stop the next write.
          }
        },
      )
      .then(() => {
        running = undefined;
        const next = waiting;
        waiting = undefined;
        if (next !== undefined && next !== written) start(next);
      });
  };
  return {
    update(text) {
      if (running !== undefined) {
        waiting = text;
        return;
      }
      if (text !== written) start(text);
    },
    async idle() {
      while (running !== undefined) await running;
    },
  };
}
