# あらB.fm private transcript search

Cloudflare Worker + D1 で、校正済み文字起こしの短い抜粋を公開検索として配信する。FTS5とQwen3 Embeddingの候補を融合し、上位20件だけBGE cross-encoderで再評価する。
文字起こしや生成した `import.sql` はリポジトリへ追加しない。

## 初回デプロイ

1. `.env.example` を `.env` にコピーし、Workers Scripts・Workers AI・D1・Vectorize の対象アカウント権限を持つAPIトークンを設定する。
2. D1を作り、表示されたIDを `wrangler.jsonc` の `database_id` に設定する。
3. Qwen3-Embedding用のVectorize索引（256次元、cosine）を作る。Matryoshka表現を256次元に縮約し、現在の12,679文書で約325万保存次元（無料枠は500万）に抑える。

```powershell
npx wrangler d1 create arkbfm-search
npx wrangler vectorize create arkbfm-search --dimensions=256 --metric=cosine
python build_import.py
npx wrangler d1 execute arkbfm-search --remote --file=import.sql
node index_vectors.mjs
npx wrangler vectorize upsert arkbfm-search --file=vectors.ndjson
node deploy.mjs --attach-domain
```

`workers_dev` は無効。検索APIは1接続元あたり毎分30回に制限し、1件あたり最大280文字の抜粋だけを返す。

## 更新

エピソード、用語集、文字起こしを更新したらSQLを再生成する。

```powershell
python build_import.py
npx wrangler d1 execute arkbfm-search --remote --file=metadata-migration.sql
node index_vectors.mjs
npx wrangler vectorize upsert arkbfm-search --file=vectors.ndjson
```

`metadata-migration.sql` はエピソード情報と用語集だけを更新する。文字起こしを更新した場合は、全文を再投入する `import.sql` を使う。どちらも対象テーブルを作り直すため、検索中の更新を避ける。
