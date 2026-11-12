# あらB.fm

ポッドキャスト「あらB.fm」のサイト（<https://www.arkbfm.com>）のソース。

- Jekyll 製の静的サイトを GitHub Pages でホストしている。`master` に push するとそのまま公開される
- 全文検索と字幕は Cloudflare Worker（<https://search.arkbfm.com>）が配信する。手順は [`cloudflare-search/README.md`](cloudflare-search/README.md)
- エピソードは `_posts/`、出演者は `_config.yml` の `actors` に書く。`_data/*.json`、`_clips/`、`_guests/`、`images/og/` は `scripts/` のスクリプトが生成する

構成、データの持ち方、編集時の注意点は [`CLAUDE.md`](CLAUDE.md) にまとめてある。

## ローカルで確認する

```bash
docker compose up   # http://localhost:4000
```

## 由来

[r7kamura/yattecast](https://github.com/r7kamura/yattecast) をもとに作り始めた。ライセンスは [`LICENSE.txt`](LICENSE.txt) を参照。
