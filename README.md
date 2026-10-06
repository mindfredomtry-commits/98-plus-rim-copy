# 98+ MVP1

Fresh implementation derived only from the frozen MVP7 Product Specification, Product
Control State Registry, Event Registry, and State × Event Matrix.

Stage 1 contains contracts and development tooling only. It intentionally contains no
transition resolver, product-flow behavior, persistence, Telegram adapters, RIM AI, or UI.

## Verification

```sh
npm install
npm run verify
```

The authoritative model currently contains exactly 30 Product Control States, 60
canonical Product Events, and 360 Matrix rules. Event IDs E-36 through E-40 are
intentionally absent. The current Product authority set is `docs/authority/mvp16/`.
The files in `docs/authority/mvp15/` are the previous set, retained because this
repository has no archive location. They are not the current authority.
