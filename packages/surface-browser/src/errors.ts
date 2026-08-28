/**
 * The one exception this driver raises.
 *
 * Everything a *surface* can do wrong is a typed fault on `PerceiveResult` / `ActResult`, because
 * "the screen would not tell me what it looks like" is a condition the classifier has a row for and
 * an exception is not. What is left over is the driver being MISUSED - a deadline of `-1`, a capture
 * format this surface does not advertise, an action dispatched after `close()`. Those are caller
 * bugs, they have no failure class, and they should stop the run loudly rather than be laundered
 * into a surface condition that a conformance suite would then grade.
 */
export class BrowserSurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSurfaceError";
  }
}
