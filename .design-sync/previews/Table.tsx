import {
  Badge,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@lead-engine/admin-ui";

const rows = [
  { id: "#4821", dir: "USDT → THB", sum: "1 200", stage: "Ждёт оплату", tone: "warning" as const },
  { id: "#4820", dir: "RUB → PHP", sum: "85 000", stage: "Оплачено", tone: "success" as const },
  {
    id: "#4817",
    dir: "USDT → RUB",
    sum: "3 400",
    stage: "Эскалация",
    tone: "destructive" as const,
  },
];

export function LeadsTable() {
  return (
    <div className="p-6">
      <Table>
        <TableCaption>Последние заявки на обмен</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Заявка</TableHead>
            <TableHead>Направление</TableHead>
            <TableHead className="text-right">Сумма</TableHead>
            <TableHead>Стадия</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-medium">{r.id}</TableCell>
              <TableCell>{r.dir}</TableCell>
              <TableCell className="text-right">{r.sum}</TableCell>
              <TableCell>
                <Badge variant={r.tone}>{r.stage}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
