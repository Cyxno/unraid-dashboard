import { Construction } from "lucide-react";
import { NAV_ITEMS } from "@/lib/navigation";

interface PlaceholderPageProps {
  title: string;
}

/**
 * Shared stub for sections that are not implemented yet. Intentionally
 * simple — each will become a real page as its data layer lands.
 */
export function PlaceholderPage({ title }: PlaceholderPageProps) {
  const item = NAV_ITEMS.find((nav) => nav.title === title);
  const Icon = item?.icon ?? Construction;
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <span className="flex size-14 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
        <Icon className="size-6" aria-hidden="true" />
      </span>
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          This section is a placeholder. It will be wired to its Unraid data
          source in an upcoming iteration.
        </p>
      </div>
    </div>
  );
}
