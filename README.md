# dsh-okayiris-registry

The shared Iris registries as ordinary dsh tools: **skills** (text an assistant reads) and **MCP servers**
(tools an assistant can use), from [skills.okayiris.com](https://skills.okayiris.com) and
[mcp.okayiris.com](https://mcp.okayiris.com). Install, use, and hand in what you reconned and researched, so
every other house gets it too.

## Why this exists

Both registries are meant to be read and contributed to by every house, but they speak HTTP and JSON and a
model speaks tools. This plugin closes that gap in both directions: reading and installing are one call each,
and contributing is a real path (signed publish, or a pull request), not a request for somebody else to do it.

## Install

```sh
dsh plugin --profile web add github:okayiris/registry-plugin
```

The plugin ships its own bundle patch, so the loader row comes with it. Yours to change is the config:

```yaml
- insert:
    - id: okayiris-registry
      name: 'dsh-okayiris-registry'
      config:
        patchFile: ''                # which patch file the MCP entries go into ('' = ~/.dsh/mcp.yml)
        house: dj947                 # optional: this house's name, for a signed publish
        keyEnv: IRIS_PLUG_KEY        # where the house key lives (a reference, never a key)
        githubTokenEnv: GITHUB_TOKEN # optional: to contribute as a pull request
        repo: okayiris/registry
```

A restart of the harness loads it. The plugin also drops its own `SKILL.md` into `~/.dsh/skills/`, so the
recon-research-write-contribute loop is part of the assistant's own instructions and not something it has to
be told.

## Tools

| Tool | Kind | What it does |
|---|---|---|
| `registry_skill_search` | read | Find skills by word and tag. |
| `registry_skill_read` | read | The whole text of a skill, with its sources. |
| `registry_skill_list` | read | What this house installed from the registry. |
| `registry_skill_install` | write | Install a skill into `~/.dsh/skills/<name>/`. Text only. |
| `registry_skill_remove` | write | Remove one that came from the registry. |
| `registry_mcp_search` | read | Find MCP servers by word and tag. |
| `registry_mcp_read` | read | One server: transport, address or command, tools, permissions. |
| `registry_mcp_list` | read | Installed servers, with the `mcp__<name>__` prefix each adds. |
| `registry_mcp_install` | write | Install a server and register it with the harness. |
| `registry_mcp_remove` | write | Remove it, and rewrite its neighbours' entries so none is lost. |
| `registry_contribute` | write | Check a folder and submit it: signed publish, or a pull request. |

## What it will not do

- **Write outside its own places.** A skill goes to `~/.dsh/skills/`, a server to `~/.dsh/registry/mcp/`. The
  one shared file it touches is the profile patch, and only between its own markers
  (`# >>> okayiris-registry` / `# <<< okayiris-registry`), so removing it can never take somebody else's
  plugin entry with it.
- **Trust a package.** Every download is checked against the SHA-256 the registry published before a single
  byte is written. A mismatch installs nothing and says so.
- **Register a server with more permissions than the owner agreed to.** `registry_mcp_install` refuses until
  `acknowledge` covers every permission the server asks for. The permission list is what a person is agreeing
  to, so it is never filled in silently.
- **Put a secret in a config file.** An `env` value in the generated entry is always a reference
  (`!!js process.env.NAME` or `vault:name`), never a literal.
- **Run anything from a skill.** A skill is text. Nothing in it is executed, ever.

## Contributing

The loop this plugin is built around: **recon → research → write → hand in**, with the sources named. A skill
without sources is a guess with a title and it is returned to you.

```sh
# write ~/skills/my-topic/{SKILL.md,skill.json}, then, from a session:
registry_contribute dir=~/skills/my-topic dryRun=true   # check only
registry_contribute dir=~/skills/my-topic               # submit
```

Inside a hosted house the submission is signed with the house key and lands in the registry's review queue.
Elsewhere it opens a pull request against [okayiris/registry](https://github.com/okayiris/registry). A person
reads it either way; on a yes it is published with one hash over its files, and a published version never
changes.

## Checks

```sh
node --test test/offline.test.mjs   # hashing, the path rules, the patch merge, the permission refusal
```

## License

MIT.
