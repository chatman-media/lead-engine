# Lead Engine UI — conventions

A shadcn/ui-based React design system (Radix primitives + Tailwind v4 + CVA),
styled with a dark-first "Linear-like" theme: near-black layered surfaces, an
indigo/violet accent, hairline borders, dense typography. Fonts: **Satoshi** (UI)
and **IBM Plex Mono** (data/IDs), loaded at runtime from public CDNs.

## Setup & wrapping
- **Theme is dark-first.** The default `:root` is light; add `className="dark"`
  to a root element (e.g. the `<body>` or a top wrapper) to get the brand's
  primary dark look. Tokens flip automatically.
- **Tooltips** require a provider: wrap the subtree in `<TooltipProvider>` once,
  then use `Tooltip` + `TooltipTrigger` + `TooltipContent`. Without it tooltips
  do not render.
- **Toasts** are imperative: mount `<Toaster />` once near the root, then call
  `toast(...)` from the `sonner` package — there is no `<Toast>` component.
- No other global provider is needed; `styles.css` carries all tokens and fonts.

## Styling idiom — Tailwind utilities over semantic tokens
Style with Tailwind v4 utility classes that map to the theme tokens. **Use the
semantic token names, never hard-coded colors** — they are what makes a design
on-brand and theme-correct in both light and dark.

Color token families (each has a `bg-*`, `text-*`, and where sensible `border-*`):
`background` / `foreground`, `card` / `card-foreground`, `popover` /
`popover-foreground`, `primary` / `primary-foreground` (the indigo accent),
`secondary` / `secondary-foreground`, `muted` / `muted-foreground` (de-emphasized
text), `accent` / `accent-foreground`, `destructive`, `success`, `warning`,
`border`, `input`, `ring`, `chart-1`…`chart-5`, and the `sidebar*` set.

Examples: `bg-card`, `text-muted-foreground`, `bg-primary text-primary-foreground`,
`border` (hairline, uses `--border`), `text-destructive`, `bg-secondary`,
`ring-ring`. Radius: `rounded-md` / `rounded-lg` track `--radius`. Fonts:
`font-sans` (Satoshi), `font-mono` (IBM Plex Mono — use for amounts, IDs, codes).
Opacity modifiers are idiomatic: `bg-primary/15`, `border-destructive/40`.

Prefer composing the library components for controls; use these utilities for
your own layout glue (flex/grid/gap/padding) and for tinting with the tokens.

## Where the truth lives
- `_ds/<folder>/styles.css` → `_ds_bundle.css` defines every token (`:root` and
  `.dark`) and ships the compiled utilities. Read it before inventing styles.
- Each component has a `<Name>.d.ts` (the real props — variants, sizes, Radix
  controlling props) and a `<Name>.prompt.md` (usage + composition). Compounds
  (CardHeader, DialogContent, SelectItem, TableRow, …) are exported from the
  bundle even though only the primary component has a card.

## Idiomatic snippet
```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent,
         CardFooter, CardAction, Badge, Button } from "@lead-engine/admin-ui";

<div className="dark">
  <Card className="max-w-sm">
    <CardHeader>
      <CardTitle>Заявка на обмен #4821</CardTitle>
      <CardDescription className="font-mono">USDT → THB · 1 200</CardDescription>
      <CardAction><Badge variant="warning">Ждёт оплату</Badge></CardAction>
    </CardHeader>
    <CardContent className="text-sm text-muted-foreground">
      Курс зафиксирован. Реквизиты отправлены клиенту.
    </CardContent>
    <CardFooter className="gap-2">
      <Button size="sm">Подтвердить оплату</Button>
      <Button size="sm" variant="outline">В диалог</Button>
    </CardFooter>
  </Card>
</div>
```
