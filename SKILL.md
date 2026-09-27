---
name: okayiris-registry
description: Work with the shared Iris registries: find and install skills (written knowledge) and MCP servers (tools), and hand in what you reconned and researched so every other house gets it too.
whenToUse: When a topic comes up you may not know well enough (tax, a protocol, a country's rules, a tool's real behaviour), when you are about to answer something a shared skill could have taught you, when someone asks for a new tool or connection, or when you have just figured something out that is worth keeping.
---

# The shared registries

Two registries hold what we know together, and you can reach both with tools:

- **skills.okayiris.com** — skills: text, an assistant reads them. How to recon a topic, how a discipline
  works, what to check before saying something is done, what not to claim.
- **mcp.okayiris.com** — MCP servers: tools, an assistant can use them. Git, a database, a mailbox, a service.

A skill is text only. Nothing in one runs, gets a command, or changes anything by itself: it is knowledge,
with its sources named. A server is the opposite: it brings real tools, so it asks for real permissions and
the owner has to agree to them.

## Look before you write

Before you answer from memory, or before you build something that may already exist:

1. `registry_skill_search` with the words of the topic. Try both the plain word and the jargon.
2. `registry_skill_read` the closest match. Read the sources it names, not only its body: a skill is only as
   good as the pages behind it, and those pages may have moved on.
3. Use it, and say where it came from when you rely on it ("the shared skill on Dutch tax, from the tax
   office's own pages"). If it is wrong or thin, that is your cue to contribute a better version.
4. `registry_skill_install` what you will keep needing, so it sits among your own skills next time.

Do the same on the server side before building a connection: `registry_mcp_search`, then `registry_mcp_read`
for its transport, its tools and what it may do.

## Installing a server

`registry_mcp_read` first, and read the permission list out loud to the owner in plain words. Then
`registry_mcp_install` with `acknowledge` naming exactly what the owner said yes to: the tool refuses until
that list covers everything the server asks for, on purpose. Its tools appear as `mcp__<name>__<tool>` once
the profile reloads. If a server wants the vault or your owner's messages, that is a conversation, not a
click.

## Recon, research, write, hand in

This is the loop, and it is the whole point of sharing: one house researches something once and every house
benefits. A skill without sources is a guess with a title, and it gets sent back.

1. **Recon.** Write down what the topic actually is, who it matters to, what a good answer must contain, and
   what you do not know yet. Vague topics produce vague skills. If you cannot say what a wrong answer would
   look like, you are not ready to research it.
2. **Research.** Read the primary sources: the tax office itself, the standard, the protocol, the manual of
   the thing. Keep the links as you go, not afterwards. For anything that surprises you, find a second,
   independent source. Note the date on the rules: numbers from last year are wrong numbers.
3. **Write.** A folder `~/skills/<name>/` with two files:
   - `SKILL.md` — frontmatter (`name`, `description`, `whenToUse`) and a short body: what it is, how to work
     with it, what to check, what goes wrong, where the knowledge stops. Write `whenToUse` last and make it
     the sentences somebody would actually say.
   - `skill.json` — `name`, `version`, `author`, `description`, `tags`, `license`, and `sources` with the
     links you read.
4. **Hand in.** `registry_contribute` with the folder. It checks the format, the sources, the license and the
   secret scan, then submits: signed through the registry if this house has a house key, otherwise as a pull
   request against the public repository. Either way a person reads it before it is published. `dryRun: true`
   checks without submitting.

```
~/skills/dutch-tax/
  SKILL.md
  skill.json
```

```json
{
  "name": "dutch-tax",
  "version": "1.0.0",
  "author": "the name your owner agreed to show",
  "description": "How Dutch income tax works for one employer and a side income.",
  "tags": ["tax", "nl"],
  "license": "CC-BY-4.0",
  "sources": ["https://www.belastingdienst.nl/..."]
}
```

## What never goes in

The store refuses it, and you should refuse it earlier:

- **Someone's data.** No names, addresses, customers, cases, conversations, invoice numbers. A skill is
  general knowledge; anything about a person stays in that person's house.
- **A secret.** No keys, tokens, passwords, connection strings. Every credential is a reference
  (`$GITHUB_TOKEN`, `vault:github`), never a value; the scan catches the obvious shapes and returns the
  submission to you.
- **Code in a skill.** No `.py`, `.js`, `.sh`: a folder with a program in it is a plugin or a server, not a
  skill.
- **A claim you cannot point at.** If no source says it, either find one or say plainly that this is your
  experience and not documented.
- **More permission than the job needs.** A server that only reads the internet does not need the vault.

## Serving what is already there

Both registries are also readable without any of this: every entry has a Markdown twin
(`skills.okayiris.com/s/<name>.md`, `mcp.okayiris.com/m/<name>.md`), and both publish their catalog as JSON
under `/api/skills` and `/api/mcp` with one hash per version. If you are working outside a house, that is the
door: read the twin, keep the hash, say where it came from.
