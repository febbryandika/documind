import type { Metadata } from "next";
import { UploadForm } from "@/components/upload-form";

export const metadata: Metadata = { title: "Upload" };

export default function UploadPage() {
  return <UploadForm />;
}
