# あらB.fm Apple Podcasts 用 RSS（arkbfm-rss）

Spotify for Creators（旧 Anchor）の RSS を取得し、各エピソードの `<item><link>` だけを公式サイトのエピソードページ（`https://www.arkbfm.com/episode/<slug>`）に差し替えて配信する Cloudflare Worker。Apple Podcasts の「エピソードの Web ページ」を公式サイトに向けるためのもので、Apple Podcasts Connect の RSS フィード URL だけをこの Worker に切り替える。

- 音声のホスティング、エピソードの公開、Spotify 側の設定は今までどおり Spotify for Creators で行う
- Spotify・その他の配信先は従来の RSS（`https://anchor.fm/s/319a2820/podcast/rss`）を読み続ける。Spotify の RSS をリダイレクトしたり、「ポッドキャストのリダイレクト」を使ったりはしない
- 公開 URL（予定）: `https://rss.arkbfm.com/`（`arkbfm.com` ゾーンのカスタムドメイン。`search.arkbfm.com` と同じ形）

## 仕組み

```
Spotify for Creators ──RSS──▶ arkbfm-rss (Worker) ──RSS──▶ Apple Podcasts
                                   ▲
www.arkbfm.com/episode-links.json ─┘（サイトのビルド時に Jekyll が出力するエピソードページの一覧）
```

1. Spotify の RSS（`SOURCE_FEED_URL`）と、サイトのエピソードページ一覧（`SITE_INDEX_URL`）を取得する
2. RSS の各 `<item>` のタイトルからエピソード番号を読み、サイトの一覧から対応するページを探す
3. 見つかった `<item>` の直下の `<link>` の中身だけを公式 URL に書き換える。それ以外のバイトは 1 バイトも変えない（GUID、enclosure、タイトル、説明文、CDATA、公開日時、シーズン・エピソード番号、種別、画像、番組情報、名前空間、`podcast:transcript` など）
4. 対応が確実に決まらない `<item>` は Spotify の元の `<link>` のまま

### エピソードとページの対応

サイトの `episode-links.json`（[`../episode-links.json`](../episode-links.json)）は `_posts/` の全記事の `title` と URL を並べたもの。記事を追加して push すれば自動で更新されるので、**対応表を手で書く必要はない**。

| RSS のタイトル | 使うラベル | サイトのページ |
|---|---|---|
| `Ep. 168 Think Outside the Output (シオン,あらB)` | `168` | `/episode/168` |
| `Ep. 164-2 All Work and All Play (...)` | `164-2` → 無ければ `164` | `/episode/164`（全パートが 1 ページ） |
| `Ep. 52-2 Koko says soso 2` | `52-2` | `/episode/52-2`（パートごとのページ） |
| `Ep. 158.5-3 Look Back in Anger (...)` | `158.5-3` → `158.5` | `/episode/158_5` |
| `Ep. 101.5 This is a Bonus Episode` | `101.5` | `/episode/101_5` |
| `Ep. 56-1 Eating persimmons rings the bell` | `56-1` → `56` | `/episode/56-1`（サイトのタイトルは `Ep. 56`） |
| `Ep. 118.5 The Aroma of Sansho` | `118.5` | `/episode/118.5` |
| `Ep.69-1 Linear algebra ...`（空白なし） | `69-1` | `/episode/69-1` |

- ラベルは `Ep.` の後の「番号」「任意の `.5`」「任意の `-パート`」。まずラベル全体で、パート付きなら番号だけでもサイトのタイトルを探す
- **URL は番号から組み立てず、サイトの一覧に載っている URL をそのまま使う**。slug の不規則さ（`131_5-1`、`118.5`、`56-1` など）に関係なく、存在するページにしかリンクしない
- 番号の取り違え対策として、英語の副題も照合する（大文字小文字・空白・記号を除いて、どちらかがもう一方で始まれば一致。`Koko says soso 2` とサイトの `Koko says soso` は一致）。副題が食い違えば元のリンクのまま
- サイトに同じラベルのページが 2 つあるときは推測せず、元のリンクのまま
- `SITE_BASE_URL`（`https://www.arkbfm.com/episode/`）の外を指す URL は使わない
- 2026-11-21 時点の実データ（RSS 234 件、サイト 225 ページ）で、全 234 件が対応し、全 225 ページが使われることを確認済み

規則で決まらない回が出たら `wrangler.jsonc` の `LINK_OVERRIDES` に GUID ごとに書く（`null` なら Spotify のリンクのまま）。

```jsonc
"LINK_OVERRIDES": { "44dad45e-6702-4977-8d08-688e56ae3a26": "https://www.arkbfm.com/episode/168" }
```

### キャッシュと障害時の動き

- 組み立てた RSS は Cache API（データセンターごと）に保存し、`REFRESH_SECONDS`（既定 900 秒）の間はそのまま返す
- 古くなったら、保存済みの RSS をすぐ返しつつ裏で作り直す。Spotify には前回の ETag を付けて問い合わせ（304 なら転送も書き換えも無し）、サイトの一覧はハッシュで比べる。どちらも変わっていなければ書き換えをせずに鮮度だけ更新する
- 作り直しに失敗したら（Spotify の 5xx・タイムアウト、XML が途中で切れている、`<rss>` でない、エピソード数が前回の半分未満に減った等）、**前回正常に作れた RSS を返し続ける**。不完全な RSS は返さない
- キャッシュが空で作れないときだけ `503`（`Retry-After: 300`）。Apple は後で取り直す
- サイトの一覧が取れないときは前回の一覧を使う。前回の一覧も無ければ、前回の RSS を返し続ける（それも無い初回だけ、Spotify のリンクのまま配信する）
- 取得先は設定の 2 URL だけ。リクエストの URL やクエリで取得先は変わらない（任意 URL のプロキシにならない）。`GET` / `HEAD` の `/` と `/status` 以外は 404 / 405
- 応答は `ETag` / `Last-Modified` 付き。`If-None-Match` には 304 を返す

### CPU 時間

Workers 無料プランの CPU 時間は 1 リクエスト 10 ms（ドキュメントでは「たまに超えるのは許容、恒常的に超えると打ち切り」）。2.5 MB の RSS を DOM にして書き戻すと収まらないため、`src/feed.js` は XML をバイト列のまま読む小さなトークナイザ（タグ、引用符内の属性値、CDATA、コメント、処理命令を区別し、要素の開閉の対応を検査する）で `<item>` 直下の `<link>` の位置だけを特定し、そこだけ差し替える。正規表現で文書全体を置換することはしない。

手元（WSL2）の計測で、書き換えは 1 回 4〜6 ms（起動直後は約 11 ms）、変更が無い時の再確認は数 ms 未満。書き換えはエピソード公開や編集で Spotify の RSS かサイトが変わった時だけ、データセンターごとに 1 回走る。本番の CPU 時間は Workers Logs（`observability` 有効）と、ダッシュボードの「Exceeded CPU Time Limits」で確認する。万一打ち切られても、前回の RSS が返り続ける。

XML として正しいかどうか、`<link>` 以外が変わっていないかは、テストと `scripts/diff-feed.mjs` で本物の XML パーサー（fast-xml-parser）を使って確かめる。

## ファイル

| パス | 内容 |
|---|---|
| `src/worker.js` | Worker 本体（取得、キャッシュ、`/` と `/status`） |
| `src/feed.js` | `<item><link>` だけを書き換えるトークナイザ |
| `src/episodes.js` | タイトルからのラベル抽出と、サイトのページとの対応 |
| `wrangler.jsonc` | Worker の設定。取得元 URL などは `vars` |
| `.dev.vars.example` | `npm run dev` のときだけ使う上書き設定の例 |
| `test/` | 自動テスト（`node --test`）とサンプル RSS |
| `scripts/diff-feed.mjs` | 2 つの RSS を XML パーサーで比べ、`<item><link>` 以外の違いをすべて報告する |
| `scripts/check-live.mjs` | 本物の Spotify RSS で書き換えを試し、対応しなかった回・差分・所要時間を表示する |
| `../episode-links.json` | サイト側。Jekyll がエピソードページの一覧を `/episode-links.json` に出力する |

### 設定（`wrangler.jsonc` の `vars`）

| 名前 | 既定値 | 内容 |
|---|---|---|
| `SOURCE_FEED_URL` | `https://anchor.fm/s/319a2820/podcast/rss` | 元の RSS |
| `SITE_INDEX_URL` | `https://www.arkbfm.com/episode-links.json` | サイトのエピソードページ一覧 |
| `SITE_BASE_URL` | `https://www.arkbfm.com/episode/` | リンク先として許す URL の前方一致 |
| `REFRESH_SECONDS` | `900` | 保存した RSS をそのまま返す秒数 |
| `FETCH_TIMEOUT_MS` | `15000` | 取得のタイムアウト |
| `LINK_OVERRIDES` | `{}` | GUID → URL（または `null`）の例外指定 |

## ローカルでの確認

Node.js 20 以上。

```bash
cd cloudflare-rss
npm install
npm test                  # 自動テスト
npm run check:live        # 本物の Spotify RSS で書き換え → out/original.xml, out/rewritten.xml
npm run diff -- out/original.xml out/rewritten.xml
```

`check:live` は、`episode-links.json` がまだ本番に無い（404）ときは `../_posts` から同じ一覧を作って試す。

Workers の実行環境（workerd）で動かす:

```bash
cp .dev.vars.example .dev.vars   # 必要なら SITE_INDEX_URL をローカルに向ける
npm run dev                      # http://localhost:8787/ と /status
curl -s http://localhost:8787/ -o local.xml
npm run diff -- https://anchor.fm/s/319a2820/podcast/rss local.xml
```

テストで確かめていること: エピソード数・GUID・enclosure・公開日時・説明文・番組情報が変わらない、`<link>` だけが正しく変わる、`.5`・パート・空白なし・slug の不規則な回、サイトに無い回や副題が違う回は元のリンクのまま、`<link>` が無い / 自己終了の `<item>`、CDATA やコメントの中の `<link>` は無視、名前空間付きの `atom:link` は対象外、URL の XML エスケープ、途中で切れた・壊れた RSS の拒否、Spotify 障害時に不完全な RSS を返さない（キャッシュがあれば前回分、無ければ 503）、新着エピソードの反映、Spotify が 304 のときに書き換えを省く、サイトだけ更新されたときの再書き換え、差分チェック自体が `<link>` 以外の変更を検出できること。

## デプロイ（要承認）

本番への反映はすべて事前に確認してから行う。順序:

1. **サイト**: `episode-links.json` と `_config.yml` の `exclude` への `cloudflare-rss` 追加を `master` に push し、`https://www.arkbfm.com/episode-links.json` が見えることを確認する（既存のページやルーティングは変わらない）
2. **Worker**: `npx wrangler deploy`（`cloudflare-search` と同じアカウント。`npx wrangler login` 済みか、Workers Scripts と `arkbfm.com` ゾーンの Workers Routes / DNS 権限を持つ `CLOUDFLARE_API_TOKEN` が要る）。初回は `rss.arkbfm.com` のカスタムドメインと DNS レコードが自動で作られる（＝本番 DNS の変更）
3. `https://rss.arkbfm.com/status` で `items` と `linkedToSite` が一致し、`keptOriginal` が空（または理由に納得できる回だけ）であることを確認する

`workers.dev` を使わない理由: Cache API が確実に動くのはカスタムドメイン上（`workers.dev` での動作はドキュメントで確認できない）。また Apple に登録する URL を自分のドメインにしておけば、将来 Worker の作り直しやホスティングの変更があっても Apple 側の URL を変えずに済む。

## Apple Podcasts Connect での切り替え（手作業）

Apple の公式手順（[How to change hosting providers](https://podcasters.apple.com/support/3965-how-to-change-hosting-providers) の「旧フィードを操作できない場合」）は「番組を選ぶ → RSS feed URL の横の Edit → 新しい URL を入力して Save」。今回は Spotify 側の RSS をリダイレクトしないため、この直接編集で切り替える。

### 切り替え前の確認

- [ ] `npm test` と `npm run check:live` が通る
- [ ] `npm run diff -- https://anchor.fm/s/319a2820/podcast/rss https://rss.arkbfm.com/` が「other differences 0」（`<item><link>` 以外の違いが無い）。直前に Spotify の RSS が更新された場合は、Worker の再取得（最長 15 分）を待ってから比べる
- [ ] `https://rss.arkbfm.com/status` の `items` が Spotify の RSS のエピソード数と同じ
- [ ] 書き換え後の `<link>` を数件ブラウザで開き、正しいページが出る（最新回、`.5` の回、パート分けの回）
- [ ] `curl -sI https://rss.arkbfm.com/` が `200`、`content-type: application/rss+xml`
- [ ] [Podcasts Connect](https://podcastsconnect.apple.com/) のフィード検証、または [Cast Feed Validator](https://castfeedvalidator.com/) 等で `https://rss.arkbfm.com/` を検証する
- [ ] 現在の RSS URL（`https://anchor.fm/s/319a2820/podcast/rss`）を控えておく（ロールバック用）

### 切り替え

1. Apple Podcasts Connect にサインインし、番組「あらB.fm」を選ぶ
2. RSS フィード URL の横の「編集」で `https://rss.arkbfm.com/` を入力して保存する
3. 新しい番組は作らない。既存番組を削除しない

### 切り替え後の確認

Apple の反映は「24 時間以内」（Podcasts Connect の Last Refresh 日時で最後の取得を確認できる）。

- [ ] Podcasts Connect に表示される RSS URL が新しい URL になり、Last Refresh が切り替え後の日時になっている。エラー表示が無い
- [ ] Apple Podcasts アプリでエピソードを開き、「…」メニュー（またはエピソード詳細）の「エピソードの Web ページ」が `www.arkbfm.com/episode/...` を開く（iPhone と Mac の両方で、最新回と古い回を数件）。アプリ側の反映にはさらに時間がかかることがあるので、変わらなければ翌日にも確認する
- [ ] **重複・消失が無い**: 番組ページのエピソード数が切り替え前と同じ。同じ回が 2 つ並んでいない（GUID は変えていないので重複は起きない想定）。ダウンロード済み・再生済みの状態が残っている
- [ ] **新着が自動で届く**: 次の回を Spotify for Creators で公開 → `/status` の `items` が 1 増える（最長 15 分＋Spotify 側の更新遅延）→ Apple Podcasts に新しい回が出る。サイトの記事を push する前は Spotify のリンク、push 後（GitHub Pages の反映と最長 15 分の後）は公式ページのリンクになる
- [ ] Spotify アプリ・Spotify for Creators の表示や統計に変化が無い

Apple のアプリが `<item><link>` を「エピソードの Web ページ」として出すことは、Apple の RSS ガイド（「An episode link URL. This is used when an episode has a corresponding webpage.」）からの推測で、表示の仕方はドキュメントに書かれていない。上の実機確認で確定させる。

### ロールバック

1. Apple Podcasts Connect で RSS フィード URL を `https://anchor.fm/s/319a2820/podcast/rss` に戻して保存する
2. GUID は同じなので、戻してもエピソードの重複や消失は起きない想定。Last Refresh が更新されたことと、エピソード数を確認する
3. Worker は止めずに少なくとも数週間残す（Apple やアプリが古い URL を読みに来る可能性があるため）。止める場合も、必ず Apple 側を戻して Last Refresh を確認してから

Worker を廃止するときも同じ順序（Apple を元の URL に戻す → 反映確認 → Worker を削除）。`<itunes:new-feed-url>` は、Spotify の RSS にも Worker の RSS にも入れない（Spotify の RSS は Spotify 側が管理し、Worker は元の RSS にあればそのまま通すだけ）。

## 運用

- 通常の公開フローは変わらない: Spotify for Creators で公開 → サイトに記事を push。それ以外の操作は不要
- 確認: `https://rss.arkbfm.com/status`（データセンターごとの値。`keptOriginal` に Spotify のリンクのままの回と理由が出る）、Cloudflare ダッシュボードの Workers Logs（`feed_built`、`feed_unchanged`、`link_kept`、`rebuild_failed`、`build_failed`、`site_index_failed`）
- 副題を Spotify とサイトで違えると、その回は Spotify のリンクのままになる（`/status` に `subtitle differs` と出る）。タイトルは両方とも `Ep. <番号> <英題> (<出演者>)` の形を保つ
- 費用: Workers 無料プランの範囲（1 日 10 万リクエスト、ログは無料枠内）。Apple の取得は 1 日に数十〜数百回程度の見込み。KV・D1 などの有料・追加サービスは使わない

## 未確認・注意点

- Apple Podcasts アプリでの「エピソードの Web ページ」表示（上記の実機確認）
- 本番 Workers での CPU 時間（ローカル計測からの見込み）。Workers Logs で `feed_built` 時の打ち切りが無いか、切り替え後しばらく確認する
- チャンネルの `<atom:link rel="self">` は Spotify の URL のまま（番組情報は変えない方針）。Apple のドキュメントにこのタグの扱いは書かれておらず、Podcasts Connect に登録した URL が使われる想定。検証ツールが「self link が取得 URL と違う」と警告する場合があるが、エラーではない
- Spotify の CDN は拠点によって数日古い RSS を返すことがある（調査時に `lastBuildDate` の違う版を受け取った）。Worker は受け取った版をそのまま通すだけで、Apple が直接 Spotify を読む場合と同じ
