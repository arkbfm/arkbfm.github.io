# CLAUDE.md

## プロジェクト概要

ポッドキャスト「あらB.fm」のサイト。Jekyll 製の静的サイトを GitHub Pages（カスタムドメイン: www.arkbfm.com）でホストし、全文検索と字幕だけ Cloudflare Worker（`search.arkbfm.com`）が配信する。

- 言語: 日本語
- 音声はこのサイトでは持たない。エピソードページは Spotify embed、つまみ聴き（`/listen/`）は番組の RSS にある音声ファイルを直接再生する
- 本物の RSS は `_config.yml` の `podcast_feed_url`（Anchor）。`feed.xml` はそこへ誘導するだけで、エピソードを載せない

## 作業を始める前に

- **必ず `git fetch` してリモートとの差を確認する。** `master` は別のマシンからも頻繁に更新される。古い手元のまま作業すると、すでに直っている箇所を直すことになる
- `master` に直接コミットして push する運用（push するとそのまま本番に出る）
- リモートの履歴は過去に書き換えられている。古い clone のコミットは同じ内容でもハッシュが違う

## ページと URL

| URL | ソース | 内容 |
|---|---|---|
| `/` | `index.html` | 最新回、テーマ、初めて聴くなら、出演者 |
| `/episode/:title` | `_posts/*.md`（`layout: article`） | エピソードのショーノート |
| `/episodes/` | `episodes/index.html` | 全エピソード（年ごと、絞り込み付き） |
| `/guests/`, `/guest/:name/` | `guests/index.html`, `_guests/*.md`（`layout: guest`） | 出演者一覧と出演者ごとの出演回 |
| `/q/:name/` | `_clips/*.md`（`layout: clip`） | 問い 1 つごとのシェア用ページ |
| `/listen/` | `listen/index.html`（`layout: listen`） | つまみ聴き（字幕・話者の顔つきの連続再生） |
| `/404.html`, `/robots.txt`, `/sitemap.xml` | `404.html`, `robots.txt`, jekyll-sitemap | |

- レイアウト: `_layouts/`（`default`, `article`, `clip`, `guest`, `listen`）
- インクルード: `_includes/`（`head.html`, `header.html`, `footer.html`, `episode-card.html`, `spotify-embed.html` など）
- CSS: SCSS（`css/main.scss` と `css/blocks/`、BEM 風命名）
- JS: `js/` の vanilla JS 4 本（`listen.js`, `home-today.js`, `episode-chapters.js`, `question-flip.js`）。ライブラリは使わない
- 検索フォームはすべて `https://search.arkbfm.com/` に GET する。サイト内に検索ページは無い

## データの持ち方

### 手で書くもの

- `_posts/YYYY-MM-DD-<slug>.md`: エピソード。slug は `156`, `52-1`, `63_5` のような形で、`/episode/<slug>` になる
- `_config.yml` の `actors`: 出演者（`image_url`, `name`, `url`）。テンプレートは `site.actors[id]`、スクリプトも `_config.yml` を直接読む
- `_data/featured_episodes.yml`, `_data/subscribe.yml`
- `images/actors/`: 出演者の画像（元画像）

### スクリプトが生成するもの（手で直さず、スクリプトを直して再生成する）

- `_data/*.json`（`episode_index`, `guests`, `topics`, `popular_episodes`, `audio_sources`, `chapter_questions`, `question_related`, `clip_related`, `related_episodes`, `themes`）
- `_guests/*.md`（`scripts/build_site_data.py`）、`_clips/*.md`（`scripts/build_clip_pages.py`）
- `images/og/`（シェア画像）、`images/actors/s/`（出演者画像の縮小版）

`listen/*.json`（`clips`, `headlines`, `related`）は生成物ではなく Liquid テンプレートで、ビルド時に `_data/` と frontmatter から組み立てられる。

各スクリプトの役割・入力・実行方法は `scripts/*.py` 冒頭の docstring に書いてある。実行前に読むこと。

### 公開しないもの

- `transcripts/`（文字起こし、再生データ、LLM の作業キャッシュ）は gitignore 済みで、このマシンに無いこともある。**絶対にコミットしない**
- 字幕は静的ファイルにせず、Worker が 1 クリップずつ返す（`/listen/captions/` は gitignore 済み）
- `transcripts/` が無い状態でスクリプトを回すと、そこから作る値は前回の出力を引き継ぐ（`build_site_data.py`）。LLM や埋め込みを使うスクリプトは API キーと `transcripts/work` のキャッシュが要る

### Post の frontmatter

```yaml
actor_ids:
  - xiPJ
  - ark_B                          # _config.yml の actors キーに対応
date: 2026-11-11 00:00:00 +0900
description: エピソードの説明文
duration: "03:45:49"
audio_url: 689VnNgZhTssiOxqsYFKbP  # Spotify エピソード ID（カンマ区切りで複数パート可）
layout: article
title: Ep. 167 Crime and Corpus (ピジェ,あらB)
questions:                         # 手で選んだ見出しの問い（最大 3 つ）
  - text: ポッドキャストの会話は、AIの学習データになる？
    time: "00:26:30"
    end: "00:38:00"
```

- 本文は `## HH:MM:SS 見出し` の章と箇条書き。章の時刻は再生位置へのリンクになる
- `title` は `Ep. <番号> <英題> (<出演者>)`。スクリプトがここから番号と副題（`subtitle`）を取り出す
- 古い記事の `audio_file_path` / `audio_file_size` はどこからも参照されていない

## 注意点

- **タイトルを書き換えない。** `build_site_data.py` は Spotify の再生データとタイトルの完全一致で突き合わせる。`Ep.65` のようにスペースの無い古いタイトルもそのままにしてある
- **テンプレートに値を出すときは `escape` を付ける。** タイトルに `"` を含む回がある（Ep. 49, 53-1, 100）。属性値（`content="..."`, `alt="..."`）では特に必須。JSON-LD には `jsonify` を使う
- frontmatter をスクリプトで読むときは、値の中の引用符を削らない（外すのは前後が対になっている引用符だけ）
- `_posts/` は CRLF の記事が大半で LF と混在している。編集時は元の改行コードを保つ
- 同じ slug の記事を 2 つ置くと `/episode/<slug>` が衝突する。日付を変えて作り直すときは古いファイルを消す
- URL は `relative_url` / `absolute_url` を使う（既存コードには `site.github.url` も残っている。ローカルでは未定義）

## 開発環境

```bash
docker compose up   # localhost:4000 で確認
```

- `Gemfile.lock` は github-pages 171 / Jekyll 3.6.2、Dockerfile は `ruby:2.4.1` と古く、現在の GitHub Pages のビルド環境とは一致しない。ローカルで通っても本番で同じ結果になるとは限らない
- スクリプトは Python 3（画像生成は Pillow、関連スポットの抽出は numpy と埋め込みモデルが必要）
- 検索と字幕の Worker は `cloudflare-search/`（Cloudflare Worker + D1 + Vectorize）。デプロイと更新の手順は `cloudflare-search/README.md`
