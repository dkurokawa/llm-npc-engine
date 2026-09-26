# データ構造 — `npc.json` / `world.json`

エンジンが読むデータの全体像。**シナリオを書く人が触るのはこの2ファイルだけ**で、
コードには一切手を入れずに別の事件が作れることを目標にする。

## 0. 設計の一線

| 役割 | 担当 |
|---|---|
| 会話の生成・嘘の言い回し | **LLM** |
| 何を知っているか / 何を隠すか | **データ**（`npc.json`） |
| **いつ開示されたか（プレイヤーが聞いたか）の判定** | **コード**（発言のキーワード部分一致。モデルが実際に何と言ったかは見ない） |
| **進行の確定・矛盾の判定** | **コード**（`world.json` の条件を評価するだけ） |

**進行判定を LLM にやらせない。** 同じことを言っても通ったり通らなかったりする揺れは、
推理ゲームでは理不尽になる。LLM は「喋る」「嘘をつく」だけを担当し、
「正解に到達したか」は決定的な条件評価で決める。

---

## 1. `world.json` — 事件の全体像

```jsonc
{
  "title": "宿場町の失踪",
  "synopsis": "旅人が一夜のうちに姿を消した。",

  // 全 NPC が共通で前提にしてよい公開情報。system prompt に常に載る。
  "common_knowledge": [
    "ここは街道沿いの宿場町「エルデン」である",
    "昨夜は雨が降っていた"
  ],

  // プレイヤーが集める事実の ID 空間。フラグの実体。
  "facts": {
    "heard_alibi":    { "label": "マーサのアリバイ主張を聞いた" },
    "found_receipt":  { "label": "雨具の受取証を見つけた" },
    "saw_cloak":      { "label": "黒いマントを目撃した証言を得た" }
  },

  // 物として持ち歩ける証拠。突きつけに使う（§4）。
  "evidence": {
    "receipt": {
      "label": "雨具の受取証",
      "description": "昨夜の日付。受取人の欄は「M」とだけある。",
      "acquired_by": ["found_receipt"]   // このフラグが立つと入手
    }
  },

  // 進行の確定（§3）。ここが Obra Dinn 型。
  "solutions": [ /* ... */ ]
}
```

### `facts` と `evidence` の使い分け

- **`facts`** = 真偽値のフラグ。「聞いた」「見つけた」という**状態**
- **`evidence`** = プレイヤーが**突きつけられる物**。`acquired_by` のフラグが立つと持ち物に入る

証拠は必ず fact に紐づく。「持っているが、どうやって手に入れたか説明できない証拠」を作らないため。

---

## 2. `npc.json` — 登場人物

```jsonc
{
  "gareth": {
    "name": "ガレス",
    "role": "宿屋の主人",

    // 口調。LLM に渡す人格定義。
    "persona": {
      "first_person": "わし",
      "speech": "語尾は「〜じゃ」。ぶっきらぼうだが親切。",
      "extra": "宿の評判を気にしている。"
    },

    // 知識。開示条件つき（§2-1）。
    "knowledge": [
      {
        "id": "thomas_was_regular",
        "content": "旅人のトマスは、この町に来るたびに顔を出す常連だった",
        "requires": []  // 省略可。省略すると既定値の [] になる（＝無条件で常に話す）
        // keywords が無い＝背景知識で、無条件・常にプロンプトに載る。
        // grants は持てない（読み込み時にエラー）— 「聞き出した瞬間」が無いので fact を立てようがない。
      },
      {
        "id": "cloak_man_stayed",
        "content": "昨夜、黒いマントの男が3号室に泊まった",
        "requires": [],
        "keywords": ["昨夜", "客", "泊", "怪しい"], // この語を含む発言で初めて開示される
        "grants": ["saw_cloak"]            // 開示された瞬間にこの fact が立つ
      },
      {
        "id": "left_at_dawn",
        "content": "その男は明け方に慌てて出て行った",
        "requires": ["saw_cloak"],         // 上が開示されるまでは候補にすら入らない
        "keywords": ["出て", "いつ", "朝"],
        "grants": ["knows_departure"]
      }
    ],

    // 知らないこと。これに触れられたら「知らん」と答えさせる。
    "unknown": [
      "黒いマントの男の名前",
      "その男の行き先"
    ],

    // 嘘（§2-2）。嘘つき NPC のみ。
    "lies": []
  },

  "martha": {
    "name": "マーサ",
    "role": "酒場の女将",
    "persona": { "first_person": "あたし", "speech": "早口。愛想はいい。" },
    "knowledge": [],
    "unknown": [],
    "lies": [
      {
        "id": "alibi_lie",
        "topic": "昨夜どこにいたか",
        "claim": "ずっと店にいた",          // LLM にはこれを本当のこととして喋らせる
        "truth": "外出していた",            // プレイヤーには見せない。突きつけ成立時に開示
        "keywords": ["昨夜", "どこ", "外", "アリバイ"], // 必須。1つ以上（§2-2）
        "grants_on_told": ["heard_alibi"], // 発言が keywords に一致したターンにだけ立つ fact
        "broken_by": ["receipt"],          // この証拠を突きつけると崩れる（§4）
        "on_broken": {
          "reaction": "動揺して口ごもる",
          "grants": ["martha_confessed"]
        }
      }
    ]
  }
}
```

### 2-1. 知識の開示制御

`knowledge[].requires` に fact ID を並べる。**全部立っていないと候補にすら入らない。**
＝ 載っていないものは、そもそもモデルが知らないので喋りようがない。これが「知らないことは
答えない」の実装。プロンプトで「答えるな」と**お願いするのではなく、情報そのものを渡さない**。
8B クラスでも壊れないのはこのため。

`requires` を満たした先、実際にいつプロンプトに載るかは `keywords` の有無で二通りに分かれる:

- **`keywords` が無い（背景知識）**: 無条件・常にプロンプトに載る。**`grants` は持てない**
  （読み込み時にエラー）。「聞き出した」という一瞬が存在しないので、そこに fact を
  立てる根拠がない。
- **`keywords` を持つ**: `requires` を満たし、かつ**そのターンのプレイヤーの発言が
  `keywords` のどれかを部分文字列として含んだとき**に初めてプロンプトに載り、その瞬間に
  「開示済み」になって `grants` の fact が立つ。一度開示されたら、以後は発言に関係なく
  常にプロンプトに載り続ける（NPC は自分が言ったことを覚えている）。

一致判定は `line.normalize("NFKC").toLowerCase()` で正規化してから部分一致を見るだけ
（`src/core/match.ts`）。**モデルが実際に何と言ったかは一切見ない** — 「聞かれたから答えた」
であって「答えた内容」で決まるわけではない。挨拶を繰り返すだけで
`saw_cloak → knows_departure → found_receipt` のような多段の開示が全部踏破される、
という抜け道はこの一線で塞がれている。

`unknown` は別枠で、**聞かれる可能性が高い禁止事項**を明示して捏造を抑える保険。
（`requires` で隠していても、モデルが推測で埋めてしまうことがある）

### 2-2. 嘘

`claim` だけを LLM に渡し、`truth` は渡さない。
**LLM は嘘だと知らずに喋る**ので、自然な嘘になる。動揺の演技も要らない。

`claim` は嘘が崩れていない間、`keywords` に関係なく常にプロンプトに載る（聞かれたら同じ嘘で
答えさせるため）。一方で「嘘を話した」（`grants_on_told` を立てる）のは知識と同じ規則で、
**そのターンの発言が `lies[].keywords` に一致したときだけ**。嘘の `keywords` は知識と違って
省略できない（最低1つ必須）— 一度も聞かれていない嘘が「話した」扱いになることはない。

---

## 3. 進行の確定 — Obra Dinn 型

**単発フラグでは、まぐれ当たりと総当たりで進んでしまう。**
複数条件が**同時に**揃ったときだけ確定させる。

```jsonc
"solutions": [
  {
    "id": "case_closed",
    "label": "事件の真相",

    // プレイヤーが埋める欄。全部正解して初めて確定する。
    "slots": [
      { "id": "culprit", "question": "誰が",     "answer": "martha",  "options": ["gareth", "martha", "traveler"] },
      { "id": "method",  "question": "どうやって", "answer": "poison",  "options": ["poison", "blade", "rope"] },
      { "id": "motive",  "question": "なぜ",     "answer": "debt",    "options": ["debt", "revenge", "jealousy"] }
    ],

    // 全欄そろっても、この fact が立っていなければ判定自体を走らせない。
    "requires": ["martha_confessed", "found_receipt"],

    "on_solved": "マーサは肩を落とし、すべてを話し始めた。"
  }
]
```

### 判定の規則（実装が守ること）

1. `requires` が未達なら**判定を走らせない**（「まだ確信が持てない」と返す）
2. 全 `slots` が埋まるまで判定を走らせない
3. 判定は**全欄一致か否かの二値**。**どの欄が違うかは教えない**

3 が肝心。「1つ合っている」と教えると、1欄ずつ総当たりできてしまい
`3 × 3 × 3 = 27通り` が `3 + 3 + 3 = 9回` に落ちる。
教えなければ組み合わせ全体を推理するしかない。

---

## 4. 追及 — L.A. Noire 型（証拠の突きつけ）

嘘（§2-2）と証拠（§1）は `broken_by` で繋がっている。

```
プレイヤー: martha に receipt を突きつける
  ↓ コードが照合するだけ（LLM は関与しない）
martha.lies[*].broken_by に "receipt" が含まれるか？
  ├ 含まれる → on_broken.grants の fact を立てる。LLM に「動揺して口ごもる」と指示して喋らせる
  └ 含まれない → 「それがどうかしましたか」と流させる。fact は立たない
```

**§2-2 の嘘と §3 の進行が1つの仕組みで繋がる。**
嘘を崩すと fact が立ち、その fact が `solutions[].requires` を満たし、初めて確定判定が開けるようになる。

---

## 5. この構造で満たせていること（§5-1 の検証）

| 要求 | どこで満たすか |
|---|---|
| ① フラグ | `world.facts` + `knowledge[].requires` / `keywords` / `grants` |
| ② 嘘をつく NPC | `npc.lies[]`（`claim` のみ LLM に渡す） |
| ③ 進行の確定 | `world.solutions[].slots`（全欄同時一致）+ `requires` |
| ④ 開示のトリガー | `knowledge[].keywords` / `lies[].keywords`（発言との部分一致。§2-1, §2-2） |
| Obra Dinn 型の複数条件ロック | `slots` の全欄一致 + どの欄が違うか教えない |
| 証言ID × 証拠ID の対応表 | `lies[].broken_by` → `evidence` の ID |
| 知らないことを答えない | `requires` 未達の knowledge は prompt に載せない + `unknown` |

**② と ③ が `broken_by` → `grants` → `requires` の一本の鎖で繋がる**ので、
別々の仕組みを2つ持たずに済む。

### 5-1. 読み込み時に拒否されるもの

`src/core/schema.ts`（zod, `.strict()`）→ `src/core/load.ts` の相互参照チェック →
`src/core/reachability.ts` の到達可能性チェック、の順に検証する。前の段で問題があれば
次の段は走らせない（形が壊れていれば ID の相互参照は無意味、参照が壊れていれば到達可能性も無意味）。

**形（zod スキーマ、`.strict()`）:**

- 型違い（例: `title` が文字列でない）
- 未知キー（例: `grants` を `grant` と打ち間違えた）
- 必須フィールドの欠落（`knowledge[].requires` は例外で、省略すると既定値 `[]` になる）
- **id として定義される全箇所**（NPC の key、`facts` / `evidence` の key、
  `knowledge` / `lie` / `solution` / `slot` の `id`）が `/^[A-Za-z0-9_-]+$/` 以外を含む。
  各 id は内部で `npcId:knowledgeId` のような複合キーの半分になる（`src/core/state.ts`）ので、
  `:` を許すと別々の (npcId, id) の組が同じ文字列に衝突しうる

**相互参照・個数・重複（`validateScenario`）:**

- NPC が 0 人 / `solutions` が 0 件
- `solution.id` の重複、同一 solution 内の `slot.id` 重複
- 同一 NPC 内の `knowledge.id` 重複、同一 NPC 内の `lie.id` 重複
- `requires` / `grants` / `grants_on_told` / `on_broken.grants` が指す fact ID が存在しない
- `evidence.acquired_by` が空（開始時から所持している扱いになってしまうため）
- `slot.answer` が `slot.options` に含まれない、`slot.options` が2択未満、`slot.options` 内の重複
- `lie.broken_by` が空（誰にも崩せない嘘になる）、`broken_by` が指す evidence ID が存在しない
- `grants` を持つのに `keywords` が無い knowledge（§2-1: 一生開示されない）
- `keywords` が空配列、または空文字を含む knowledge / lie（省略＝背景知識と、書くなら1つ以上、の二択しかない）

### 5-2. 到達可能性の検査

相互参照が正しくても、空の状態から実際に辿り着けるとは限らない（例: 証拠 A の入手に fact B が要り、
B は A を突きつけて嘘を崩さないと立たない、という循環）。`src/core/reachability.ts` が空の fact 集合
から不動点まで到達可能な fact / 入手可能な証拠を計算し、到達不能な証拠・`requires` を満たせない
solution・`requires` を満たせない knowledge（`grants` の有無を問わず）を problems に出す。

---

## 6. 2本目（脱出/交渉）への転用

推理は「情報を集めて**確定**させる」、脱出/交渉は「相手の**態度を変えさせる**」。
状態機械は違うが、**同じ骨格に乗る**:

| 推理 | 脱出/交渉 |
|---|---|
| `facts`（集めた事実） | 同じ（何を相手に話したか） |
| `solutions[].slots`（誰が・どうやって・なぜ） | 説得度の閾値 |
| `lies[].broken_by`（証拠 → 嘘が崩れる） | `persuasion[].moved_by`（情報 → 態度が動く） |

**`broken_by` の「IDの対応表で決定的に状態を動かす」形がそのまま流用できる。**
1つの素体で2種類の状態機械を見せられるのが、素体を公開する側の説得力になる。
