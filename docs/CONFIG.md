# CONFIG

The adapter reads one settings file and writes its log to another path. Both are resolved
per key, with the project scope winning over the global scope, and a key that is missing or
invalid at one scope falls through to the next.

## Scopes

| scope | path |
| --- | --- |
| project | `<cwd>/.pi/plannotator-goal.json` |
| global | `<agent dir>/plannotator-goal.json` |

`<agent dir>` is `PI_CODING_AGENT_DIR` when set (absolute, or relative to the home
directory), otherwise `~/.pi/agent`. This matches how pi-goal-x resolves its own agent dir.

Unknown keys are tolerated, so the file can carry a comment field or a key owned by a later
version. Only these three keys are read.

## Keys

### `enabled`

Type boolean, default `false`.

Only an explicit `true` enables the adapter. Every other value keeps it silent:

| file content | enabled |
| --- | --- |
| file missing | false |
| `not json` | false |
| `{}` | false |
| `{"enabled":"true"}` | false |
| `{"enabled":false}` | false |
| `{"enabled":true}` | true |

The string `"true"` is deliberately not coerced. The kill switch came from M3 finding D-16:
a value that is not literally `true` must not start a handoff.

### `validatePath`

Type string, default `<agent dir>/plans/validate.mjs`.

The plan validator is executed as `node <validatePath> <planPath>` before the handoff. A
non-zero exit refuses the handoff and quotes the validator output. A relative path is
resolved against `cwd`; an absolute path is used as given.

The validator itself is owned by the dotfiles repository and is reached only through this
key, so this repository never carries a copy of it.

### `logPath`

Type string, default `<agent dir>/plans/plannotator-goal.jsonl`.

The JSONL sink. One line per event, with a call-time `ts`. A relative path is resolved
against `cwd`; an absolute path is used as given.

The historical M3 sink was `<agent dir>/plans/probes/m3-adapter-log.jsonl`. That directory
belongs to the adapter's own probe suite and was removed in the same cutover that moved the
adapter into its own repository, so the default no longer writes there: a default that
recreated a deleted directory would be the deletion undoing itself on the first handoff. Set
`logPath` explicitly to the historical path if the old file is still wanted.

## Precedence and fallback

Resolution is per key, not per file:

1. the key is present and valid in the project file -> project
2. otherwise present and valid in the global file -> global
3. otherwise the compiled default

A key that is missing at the project scope falls through to the global scope. A key whose
value has the wrong type is ignored and produces a note in the log; it does not disable the
adapter, so a single bad edit in a project file cannot silently turn the handoff off.

A file that exists but cannot be parsed produces a note and is ignored entirely. A file that
does not exist is silent, which is the normal case for a project that has not opted in.

## Example

Global, agent dir, opt in for every project:

```json
{
  "enabled": true
}
```

Project, opt in for one repository and keep its log local:

```json
{
  "enabled": true,
  "logPath": ".pi/plannotator-goal.log.jsonl"
}
```

## Resolved config shape

`resolveConfig(cwd, env, homeDir)` returns:

- `enabled`, `validatePath`, `logPath`: the resolved values
- `sources`: the winning scope for each key, one of `project`, `global`, `default`
- `notes`: human-readable descriptions of files that were ignored

`test/config.test.ts` covers the truth table, the precedence rules, malformed JSON, a wrongly
typed value, relative and absolute overrides, and payload validation.