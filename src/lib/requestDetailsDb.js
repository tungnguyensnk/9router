// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  saveRequestDetail, getRequestDetails, getDistinctRequestDetailProviders, getRequestDetailById,
} from "@/lib/db/index.js";
