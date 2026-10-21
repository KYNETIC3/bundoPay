import { redirect } from "next/navigation";

// Store data now lives in Settings.
export default function DataPage() {
  redirect("/settings#data");
}
