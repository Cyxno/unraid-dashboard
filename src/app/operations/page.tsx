import type { Metadata } from "next";
import OperationsView from "@/components/operations/operations-view";

export const metadata: Metadata = {
  title: "Operations — Unraid Dashboard",
  description: "Operator status and safe recovery actions.",
};

export default function OperationsPage() {
  return <OperationsView />;
}
