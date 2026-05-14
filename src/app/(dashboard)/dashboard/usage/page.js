"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UsageStats, RequestLogger, CardSkeleton, SegmentedControl, Button, Modal } from "@/shared/components";
import RequestDetailsTab from "./components/RequestDetailsTab";

const PERIODS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

const DELETE_OPTIONS = [
  { value: "1d", label: "Older than 1 day" },
  { value: "7d", label: "Older than 7 days" },
  { value: "30d", label: "Older than 30 days" },
  { value: "all", label: "Delete all" },
  { value: "custom", label: "Custom range" },
];

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [tabLoading, setTabLoading] = useState(false);
  const [period, setPeriod] = useState("7d");
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteMode, setDeleteMode] = useState("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteResult, setDeleteResult] = useState(null);

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    setTabLoading(true);
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
    setTimeout(() => setTabLoading(false), 300);
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteResult(null);
    try {
      const body = { mode: deleteMode };
      if (deleteMode === "custom") {
        body.customRange = { startDate: customStart, endDate: customEnd };
      }
      const res = await fetch("/api/usage/history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setDeleteResult("success");
        setTimeout(() => {
          setDeleteModalOpen(false);
          setDeleteResult(null);
          window.location.reload();
        }, 1000);
      } else {
        const data = await res.json();
        setDeleteResult(data.error || "Failed to delete");
      }
    } catch {
      setDeleteResult("Network error");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Tabs + period selector on same row */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          options={[
            { value: "overview", label: "Overview" },
            { value: "details", label: "Details" },
          ]}
          value={activeTab}
          onChange={handleTabChange}
          className="w-full sm:w-auto"
        />
        <div className="flex items-center gap-2">
          {activeTab === "overview" && (
            <SegmentedControl
              options={PERIODS}
              value={period}
              onChange={setPeriod}
              size="sm"
              className="w-full sm:w-auto"
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            icon="delete"
            onClick={() => setDeleteModalOpen(true)}
          >
            Clear History
          </Button>
        </div>
      </div>

      {tabLoading ? (
        <CardSkeleton />
      ) : (
        <>
          {activeTab === "overview" && (
            <Suspense fallback={<CardSkeleton />}>
              <UsageStats period={period} setPeriod={setPeriod} hidePeriodSelector />
            </Suspense>
          )}
          {activeTab === "logs" && <RequestLogger />}
          {activeTab === "details" && <RequestDetailsTab />}
        </>
      )}

      <Modal
        isOpen={deleteModalOpen}
        onClose={() => { setDeleteModalOpen(false); setDeleteResult(null); }}
        title="Clear Usage History"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteModalOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              loading={deleting}
              disabled={deleteMode === "custom" && (!customStart || !customEnd)}
            >
              Delete
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-text-muted text-sm">Select which usage history data to delete:</p>
          <div className="flex flex-col gap-2">
            {DELETE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  deleteMode === opt.value
                    ? "border-brand-500 bg-brand-500/5"
                    : "border-border-subtle hover:bg-surface-2"
                }`}
              >
                <input
                  type="radio"
                  name="deleteMode"
                  value={opt.value}
                  checked={deleteMode === opt.value}
                  onChange={(e) => setDeleteMode(e.target.value)}
                  className="accent-brand-500"
                />
                <span className="text-sm text-text-main">{opt.label}</span>
              </label>
            ))}
          </div>
          {deleteMode === "custom" && (
            <div className="flex flex-col gap-2 mt-2">
              <label className="text-xs text-text-muted">Start date</label>
              <input
                type="datetime-local"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-main text-sm"
              />
              <label className="text-xs text-text-muted">End date</label>
              <input
                type="datetime-local"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-main text-sm"
              />
            </div>
          )}
          {deleteResult && (
            <p className={`text-sm ${deleteResult === "success" ? "text-green-500" : "text-red-500"}`}>
              {deleteResult === "success" ? "Deleted successfully!" : deleteResult}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
