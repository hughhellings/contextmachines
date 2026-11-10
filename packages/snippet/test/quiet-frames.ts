/**
 * Loaded before each snippet test file (vitest.config.ts). happy-dom never loads the page behind an
 * <iframe src> in tests, and says so on Node's own console with a stack trace for every frame a
 * test writes. That is the test browser describing itself, not the code under test failing, so
 * exactly that message is left out; anything else on the console still prints.
 */
import nodeConsole from "node:console";

/** happy-dom's notice that it didn't load a frame's page, and nothing else. */
export const isFrameNotice = (args: unknown[]): boolean =>
  args.length === 1 && args[0] instanceof Error && args[0].name === "NotSupportedError" && /^Failed to load iframe page ".*"\. Iframe page loading is disabled\.$/.test(args[0].message);

const error = nodeConsole.error.bind(nodeConsole);
nodeConsole.error = (...args: unknown[]) => {
  if (!isFrameNotice(args)) error(...args);
};
