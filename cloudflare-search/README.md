# あらB.fm private transcript search

Cloudflare Worker + D1 で、校正済み文字起こしの短い抜粋を公開検索として配信する。FTS5とQwen3 Embeddingの候補を融合し、発話区間の重複加点を抑える。エピソード概要のベクトル候補も別枠で追加し、上位30件をJevで再評価する。Jevが使えない場合はBGE rerankerへ切り替える。
文字起こしや生成した `import.sql` はリポジトリへ追加しない。

## 初回デプロイ

1. `.env.example` を `.env` にコピーし、Workers Scripts・Workers AI・D1・Vectorize の対象アカウント権限を持つAPIトークンを設定する。
2. D1を作り、表示されたIDを `wrangler.jsonc` の `database_id` に設定する。
3. Qwen3-Embedding用のVectorize索引（256次元、cosine）を作る。Matryoshka表現を256次元に縮約し、約1.3万文書で約330万保存次元（無料枠は500万）に抑える。

```powershell
npx wrangler d1 create arkbfm-search
npx wrangler vectorize create arkbfm-search --dimensions=256 --metric=cosine
python build_import.py
npx wrangler d1 execute arkbfm-search --remote --file=import.sql
node index_vectors.mjs
npx wrangler vectorize upsert arkbfm-search --file=vectors.ndjson
node ensure_episode_filter.mjs
node deploy.mjs --attach-domain
```

`ensure_episode_filter.mjs` は既存の索引に `kind` メタデータ索引を作成し、エピソード概要ベクトルだけを再登録する。繰り返し実行可能。検索時には通常の上位50文書に加え、概要だけの上位20文書を取得する。概要検索が失敗した場合は通常の検索を続ける。

大量の検索評価はリモートD1ではなくローカルSQLiteで行う。Workers FreeのD1行読み取り枠は1日500万行で、超過するとUTC 0時のリセットまで検索が失敗する。
スペル補正は語頭・語尾の式索引を使い、同頻度候補は元の登録順で並べる。トップページでよく使う2文字の話題は `short_segment_hits` に従来の `LIKE` の先頭200件を保存する。それ以外の短い語は従来どおり全文を照合する。既存DBへの適用順は `node apply_search_indexes.mjs --cache` → `node deploy.mjs` → `node apply_search_indexes.mjs --vocabulary`。全文再投入時は `build_import.py` が短語キャッシュを生成する。語彙索引はD1無料枠の1日10万行書き込みに収めるため `import.sql` から除外されるので、翌日の枠リセット後に `node apply_search_indexes.mjs --vocabulary` を実行する。
話者検索はチャンク全件を走査せず、`episode_speakers` のエピソード別話者名を照合する。元の `segments.speaker` 文字列を重複だけ除いて保存するため、部分一致と検索結果の順序は維持する。既存DBでは `node apply_speaker_index.mjs` を実行してから `node deploy.mjs` を実行する。新規の全文投入では `build_import.py` が同じ表を生成する。

`workers_dev` は無効。検索APIは1接続元あたり毎分30回に制限し、1件あたり最大280文字の抜粋だけを返す。同じ検索語の成功結果はエッジのCache APIに1時間保存し、埋め込み・Jevの再実行を省く。キャッシュはデータセンター単位だが、検索のたびにD1の `search_cache_version` を読んでキーに含める。データ更新後に世代を変えると、全拠点で旧結果を即座に参照しなくなる（旧エントリは最大1時間で自然に消える）。世代の取得に失敗した場合はキャッシュを使わず通常検索を続ける。レスポンスの `Server-Timing` に各段階の所要時間、`X-Search-Cache` に `HIT`/`MISS` を付ける。

## 更新

エピソード、用語集、文字起こしを更新したらSQLを再生成する。

```powershell
python build_import.py
npx wrangler d1 execute arkbfm-search --remote --file=metadata-migration.sql
node index_vectors.mjs
npx wrangler vectorize upsert arkbfm-search --file=vectors.ndjson
node invalidate_search_cache.mjs
```

`metadata-migration.sql` はエピソード情報と用語集だけを更新する。文字起こしを更新した場合は、全文を再投入する `import.sql` を使う。生成SQLは適用完了時にキャッシュ世代を変更する。Vectorizeを直接更新した後や、手動でD1の検索対象を変えた後は `node invalidate_search_cache.mjs` を実行する。`deploy.mjs`・話者更新スクリプト・`ensure_episode_filter.mjs` も成功時に世代を変更する。対象テーブルを作り直す更新中は検索を避ける。

## つまみ聴きの字幕

つまみ聴き（`/listen/`）とトップページの「今日の3問」の字幕は、静的ファイルではなくこのWorkerの `GET /api/captions` が1クリップ分ずつ返す。`?c=<クリップID>`（`listen/clips.json` の `i`）か、問いのない場面は `?ep=<slug>&p=<パート>&t=<開始秒>&e=<終了秒>`（最大1800秒。長い場面はページが分割して取得する）で指定する。中身は `scripts/build_captions.py` が書き出す公開中の問いの回答区間だけで、非表示の問いのIDは存在しない扱い（404）になる。

- `Origin` が `https://www.arkbfm.com`（と `http://localhost:4000` などの開発用）以外なら403。CORSは許可したOriginだけに返す。
- 検索とは別の `CAPTION_RATE_LIMIT`（1接続元あたり毎分30回）で、超過は429。字幕で検索枠を消費しない。
- 不正な指定は400、存在しないクリップ・字幕のない区間は404、D1の失敗（更新中のテーブル入れ替えを含む）は503。ページは字幕なしで再生を続け、次に同じクリップを開いたとき再取得する。
- 成功結果はエッジのCache APIに1日、ブラウザに1時間保存する。キャッシュキーには `caption_cache_version` の世代を含め、世代はisolateごとに最長1分だけ保持するので、キャッシュヒット時はD1を読まない。字幕の更新は検索キャッシュ（`search_cache_version`）を無効化しない。
- D1には `caption_clips`（ID→区間）、`caption_episodes`（話者）、`caption_chunks`（パートごと5分単位の字幕）を置く。1リクエストの読み取りは数行。全件更新の書き込みは約8千行（無料枠の1日10万行の内）。

字幕（問いの区間・非表示・話者名・文字起こし）を更新したら以下を実行する。`captions.sql` は文字起こし本文を含むため `import.sql` と同じくリポジトリへ追加しない。

```powershell
python ../scripts/build_captions.py
npx wrangler d1 execute arkbfm-search --remote --file=captions.sql
```

`captions.sql` は `*_next` テーブルへ投入してから入れ替え、最後に字幕キャッシュの世代を変更する。入れ替えの瞬間だけ503になりうるが、Workerの再デプロイは不要。ブラウザに保存済みの字幕は最長1時間残るため、非表示にした問いを即座に消す必要がある場合はこの点に注意する。

### デプロイ順

初回、またはWorkerの字幕処理を変えたときは、必ずD1 → Worker → サイトの順にする。

1. `python ../scripts/build_captions.py` と `npx wrangler d1 execute arkbfm-search --remote --file=captions.sql`（字幕テーブルを用意）
2. `node deploy.mjs`（字幕テーブルが空・未作成なら中止する。成功時に検索と字幕の両方のキャッシュ世代を変更）
3. サイト（`_config.yml` の `captions_api`、`js/listen.js`、`js/home-today.js`）をpushしてGitHub Pagesへ反映

逆順にするとサイトが未デプロイのAPIを呼び、その間は字幕が出ない（再生自体は続く）。ローカルのJekyllで試すときは `captions_api` を上書きした設定ファイルを `--config _config.yml,<上書き>.yml` で渡す。

## 話者名付き抜粋

検索用の各チャンクには、人手で確定した発話ごとの名前と開始時刻を `speaker_turns` に保存する。Workerは一致箇所の発話を最大280文字だけ取り出し、`あらB: ...` のように表示する。未確定の発話は「話者不明」と表示する。話者名の更新後は以下を実行する。

```powershell
python build_speaker_turns_migration.py --updates-only
node apply_speaker_turns_migration.mjs
node deploy.mjs
```

既存の検索DBに初めて適用する場合だけ `--updates-only` を外す。生成される `speaker-turns-migration.sql` には文字起こし本文を含めず、リポジトリには追加しない。全文の再投入は不要。
