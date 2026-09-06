/**
 * Conventional Changelog preset for RemitMortgage releases.
 * Non-conventional commits are ignored by the parser and do not fail generation.
 */
module.exports = {
  writerOpts: {
    groupBy: "type",
    commitGroupsSort: "title",
    commitsSort: ["scope", "subject"],
    noteGroupsSort: "title",
  },
  linkCompare: true,
  linkReferences: true,
  issuePrefixes: ["#"],
  commitUrlFormat: "{{host}}/{{owner}}/{{repository}}/commit/{{hash}}",
  compareUrlFormat:
    "{{host}}/{{owner}}/{{repository}}/compare/{{previousTag}}...{{currentTag}}",
  issueUrlFormat: "{{host}}/{{owner}}/{{repository}}/issues/{{id}}",
  userUrlFormat: "{{host}}/{{user}}",
  types: [
    { type: "feat", section: "Features" },
    { type: "fix", section: "Bug Fixes" },
    { type: "perf", section: "Performance" },
    { type: "refactor", section: "Refactoring" },
    { type: "docs", section: "Documentation" },
    { type: "test", section: "Tests" },
    { type: "build", section: "Build System" },
    { type: "ci", section: "CI" },
    { type: "chore", section: "Chores" },
    { type: "revert", section: "Reverts" },
  ],
};
