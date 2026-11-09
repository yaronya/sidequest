# sidequest

A Claude Code mod that keeps your main session on track. When an answer raises side topics, sidequest spins them off as side quests: background sessions forked from the current one, so they keep the full context.

- `/quests` picks out the side quests in the last answer. Press a number to fork one, `a` for all of them.
- `/dig <topic>` starts a side quest on a topic you type yourself, and Haiku gives it a short title. `/dig <title>: <topic>` sets the title yourself.
- The footer shows how many side quests are ready and running (`⑂ 1 ready · 2 running`), and a toast tells you when one is ready.
- A side quest knows where it came from: its first prompt names the parent session's id and name, and its footer reads `⑂ from <parent>`.
- `/questlog` opens a pane listing all the side quests.
- `/harvest` brings the ready side quests' conclusions back into the main session.

Every side quest shows up in the `claude agents` view as `⑂ <title>`, so it stands apart from sessions you started yourself.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install sidequest --marketplace yaronya/sidequest
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install sidequest --marketplace yaronya/sidequest
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `yaronya/sidequest`, then Add plugin.
