# あらB.fm private transcript search

Cloudflare Worker + D1 + Access で、校正済み文字起こしを認証付き検索として配信する。
文字起こしや生成した `import.sql` はリポジトリへ追加しない。

## 初回デプロイ

1. `.env.example` を `.env` にコピーし、対象アカウントのIDと権限を限定したAPIトークンを設定する。
2. Cloudflare Zero Trust で `search.arkbfm.com` の Access Application を先に作り、許可するメールアドレスを限定する。
3. D1を作り、表示されたIDを `wrangler.jsonc` の `database_id` に設定する。

```powershell
npx wrangler d1 create arkbfm-search
python build_import.py
npx wrangler d1 execute arkbfm-search --remote --file=import.sql
node deploy.mjs --attach-domain
```

`workers_dev` は無効。Accessを作る前にカスタムドメインへデプロイしないこと。Access Application は `search.arkbfm.com` だけを対象にし、公開中の `www.arkbfm.com` は含めない。

## 更新

エピソード、用語集、文字起こしを更新したらSQLを再生成する。

```powershell
python build_import.py
npx wrangler d1 execute arkbfm-search --remote --file=metadata-migration.sql
```

`metadata-migration.sql` はエピソード情報と用語集だけを更新する。文字起こしを更新した場合は、全文を再投入する `import.sql` を使う。どちらも対象テーブルを作り直すため、検索中の更新を避ける。
