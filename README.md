# llm-npc-engine

NPCs that talk through an LLM, in a game whose progression is decided in code.

The model speaks freely and lies convincingly. It never decides whether you have
solved anything. That line is the whole design: an 8B model running on a laptop
can play every character in a mystery without being able to make the case
unwinnable, or let you stumble into the ending by luck.

```bash
pnpm install
ollama pull llama3.1:8b-instruct-q4_k_m   # or edit .env for another backend
cp .env.example .env
pnpm play
```

## The split

| | Decided by |
|---|---|
| What a character says, and how | **the LLM** |
| Whether they lie, and about what | **the data** (`npc.json`) |
| Whether a lie has been broken | **code** — an id lookup |
| Whether the case is solved | **code** — a multi-condition lock |

Asking a model "did the player just work it out?" gives a different answer on
different runs. In a mystery that reads as the game cheating. So the model is
never asked.

### Knowledge it does not have, it cannot leak

Each thing a character knows carries a `requires` list. Until those facts hold,
the text is simply absent from the prompt — the model is not instructed to keep
a secret, it is never told the secret. This is what survives at 8B, where an
instruction not to reveal something often does not.

### Lies are told, not performed

A lying character is handed the lie as plain fact and no hint that it is one.
The truth stays engine-side. The result sounds unrehearsed because, as far as
the model knows, it is just answering honestly.

### The ending has one key, not three

Closing a case means naming who, how, and why — all correct at the same time. A
wrong accusation says only that it was wrong. Revealing which parts were right
would turn 27 combinations into nine guesses, so it doesn't.

```
$ pnpm play
ガレス「明け方になると急に出て行った。お金も置かずに逃げて行ったんだ。」
  * 分かったこと: その男が明け方に慌てて出て行ったと聞いた

> /show receipt
  雨具の受取証を突きつけた。
  * 分かったこと: マーサが外出を認めた
マーサ「え、雨具を借りたか……そのときは外に出てたはずなんだけど……」
```

## Backends

One line in `.env` moves between a local model, any OpenAI-compatible provider,
and Claude. Nothing above `src/llm/` knows which is in use.

```
LLM_BACKEND=ollama          # local, no key, no cost
LLM_BACKEND=openai-compat   # any provider speaking the OpenAI shape
LLM_BACKEND=anthropic       # Claude
```

Model names live in `.env` rather than in the source, because they age out
faster than the code does.

## Writing a scenario

Two files, no code: `world.json` for the case, `npc.json` for the cast.
[`docs/schema.md`](docs/schema.md) walks through both, and
[`scenarios/sample/`](scenarios/sample/) is a complete small mystery. Both files
are checked on load, so a mistyped id fails immediately instead of becoming a
line of dialogue that never unlocks.

## Layout

```
src/core/   progression, disclosure, prompt building — no network, fully tested
src/llm/    the three backends behind one interface
src/cli/    a terminal front end; a browser one would replace only this
```

```bash
pnpm test        # the rules, offline and deterministic
pnpm typecheck
```

The tests include an exhaustive pass over every combination of a case's
answers, asserting exactly one is accepted.

Runs on Node 22+ with no runtime dependencies.

## License

MIT.
