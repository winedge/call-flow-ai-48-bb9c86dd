import { useState } from "react";
import { ShoppingCart, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  buyTwilioNumber,
  searchAvailableNumbers,
  type AvailableNumber,
} from "@/lib/telephony/buy-numbers.functions";

type NumType = "Local" | "TollFree" | "Mobile";

export function BuyNumberDialog({ onPurchased }: { onPurchased: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [country, setCountry] = useState("US");
  const [type, setType] = useState<NumType>("Local");
  const [areaCode, setAreaCode] = useState("");
  const [contains, setContains] = useState("");
  const [results, setResults] = useState<AvailableNumber[]>([]);
  const [searching, setSearching] = useState(false);
  const [buying, setBuying] = useState<string | null>(null);

  const search = async () => {
    setSearching(true);
    try {
      const res = await searchAvailableNumbers({
        data: {
          country,
          type,
          areaCode: areaCode.trim() || undefined,
          contains: contains.trim() || undefined,
        },
      });
      if (!res.ok) {
        toast.error(res.message);
        setResults([]);
        return;
      }
      setResults(res.numbers);
      if (res.numbers.length === 0) toast.message("No numbers found — try another area code.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const buy = async (n: AvailableNumber) => {
    if (!window.confirm(`Buy ${n.phone_number}? Your Twilio account will be charged.`)) return;
    setBuying(n.phone_number);
    try {
      const res = await buyTwilioNumber({ data: { phoneNumber: n.phone_number, type } });
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      toast.success(res.message);
      setResults((r) => r.filter((x) => x.phone_number !== n.phone_number));
      await onPurchased();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Purchase failed");
    } finally {
      setBuying(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <ShoppingCart className="size-3.5 mr-1" /> Buy number
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Buy a new number</DialogTitle>
          <DialogDescription>Search Twilio's available numbers and purchase one instantly.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <Label className="text-xs mb-1 block">Country</Label>
            <Select value={country} onValueChange={setCountry}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["US", "CA", "GB", "AU"].map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as NumType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="Local">Local</SelectItem>
                <SelectItem value="TollFree">Toll-free</SelectItem>
                <SelectItem value="Mobile">Mobile</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs mb-1 block">Area code</Label>
            <Input value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 862" maxLength={4} />
          </div>
          <div>
            <Label className="text-xs mb-1 block">Contains</Label>
            <Input value={contains} onChange={(e) => setContains(e.target.value.replace(/[^\d*]/g, ""))} placeholder="e.g. 555" maxLength={10} />
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => void search()} disabled={searching}>
            <Search className="size-3.5 mr-1" /> {searching ? "Searching…" : "Search"}
          </Button>
        </div>
        <div className="max-h-80 overflow-y-auto space-y-2">
          {results.map((n) => (
            <div key={n.phone_number} className="flex items-center justify-between gap-3 bg-muted p-3 rounded-md">
              <div>
                <p className="font-mono text-sm">{n.friendly_name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {[n.locality, n.region].filter(Boolean).join(", ") || "—"} · {[n.voice && "voice", n.sms && "sms"].filter(Boolean).join(", ")}
                </p>
              </div>
              <Button size="sm" onClick={() => void buy(n)} disabled={buying !== null}>
                {buying === n.phone_number ? "Buying…" : "Buy"}
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
