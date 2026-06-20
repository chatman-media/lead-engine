import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lead-engine/admin-ui";

export function Direction() {
  return (
    <div className="p-6">
      <Select defaultValue="usdt-thb" defaultOpen>
        <SelectTrigger className="w-64">
          <SelectValue placeholder="Направление обмена" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="usdt-thb">USDT → THB (Таиланд)</SelectItem>
          <SelectItem value="rub-php">RUB → PHP (Филиппины)</SelectItem>
          <SelectItem value="usdt-rub">USDT → RUB</SelectItem>
          <SelectItem value="usdt-usd">USDT → USD (наличные)</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
