// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs, deleteUsageHistory,
  saveRequestDetail, getRequestDetails, getDistinctRequestDetailProviders, getRequestDetailById,
} from "@/lib/db/index.js";
