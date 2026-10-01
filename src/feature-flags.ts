export type FeatureName =
  | 'cost_dashboard'       // Tier 3 — Pro
  | 'token_breakdown'      // Tier 3 — Pro
  | 'budget_alerts'        // Tier 3 — Pro
  | 'cost_forecasting'     // Tier 3 — Pro
  | 'free_only_mode'       // Tier 3 — Pro
  | 'hard_stop'            // Tier 3 — Pro
  | 'context_window_gauge' // Tier 2 — Pro (if fields land upstream)
  | 'multi_gateway_ui'     // v1.1
  ;

// Features available without Pro license
export const FREE_FEATURES: FeatureName[] = [
  // All Tier 1 + Tier 2 features are free
  // Tier 3 cost features are Pro-only (not listed here)
];
