// The Hub's side of the Artifact rule. The rule itself (which tool calls write
// a page, what a version of it is) lives in the page's own code,
// public/js/artifact-rules.js, and is imported from there rather than copied:
// the Artifact panel and the Hub must agree on it, and two copies drift (they
// had: three of them, each a little different).
export { ARTIFACT_TOOL, artifactOf, artifactIndex, indexEntry, replayVersion } from '../public/js/artifact-rules.js';
