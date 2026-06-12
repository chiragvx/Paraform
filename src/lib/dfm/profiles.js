/**
 * DFM process profiles (spec tracker/11-cheap-dfm.md + tracker/13-…).
 *
 * Each profile names a manufacturing process and supplies thresholds the
 * check library reads. `enabledChecks` selects which checks the runner
 * applies for that profile.
 *
 * Profiles are kept plain-data on purpose: settings UI can render them
 * directly, and the runner can serialise the active set into the repair
 * loop's prompt without any conversion.
 *
 * Spec-13 additions (standard-parts relational fit check):
 *   bearingFitDefaults  — default fit class + tolerance multipliers
 *                         consumed by bearingBoreFit / shaftBearingFit.
 *   threadEngagementMultiplier — host-material-keyed minimum thread
 *                         engagement (× nominal Ø) consumed by
 *                         threadEngagement.
 */

export const PROFILES = {
    '3d-print': {
        label: '3D Print (FDM)',
        minWallMm: 0.8,
        minHoleMm: 1.5,
        minFeatureMm: 0.4,
        // FDM tolerances are coarse; a running fit (H7/g6) is the right
        // assumption for a press-on / slide-on bearing seat printed in
        // PLA/PETG. The plastic/aluminum/steel multipliers below mostly
        // bite on heat-set inserts (plastic case) — keep the 2× factor.
        bearingFitDefaults: {
            class: 'H7/g6',
            warningMultiplier: 1.0,
            errorMultiplier: 5.0,
        },
        threadEngagementMultiplier: {
            steel:    1.0,
            aluminum: 1.5,
            plastic:  2.0,
        },
        enabledChecks: [
            'manifoldness',
            'selfIntersection',
            'zeroThickness',
            'holePatternValidity',
            'filletEdgeLength',
            'bearingBoreFit',
            'shaftBearingFit',
            'clearanceHoleSize',
            'threadEngagement',
        ],
    },

    'cnc-mill': {
        label: 'CNC Milling',
        minWallMm: 1.0,
        minHoleMm: 2.0,
        minToolRadiusMm: 1.0,    // for internal corners
        maxAspectRatio: 10,
        // CNC mills can hold a tighter slide fit by default — H7/h6 is
        // a line-to-line "locational" fit that a 5-axis mill on a
        // production part can land without lapping. Designers who
        // explicitly want a running fit declare H7/g6 per-feature.
        bearingFitDefaults: {
            class: 'H7/h6',
            warningMultiplier: 1.0,
            errorMultiplier: 5.0,
        },
        threadEngagementMultiplier: {
            steel:    1.0,
            aluminum: 1.5,
            plastic:  2.0,
        },
        enabledChecks: [
            'manifoldness',
            'selfIntersection',
            'holePatternValidity',
            'filletEdgeLength',
            'bearingBoreFit',
            'shaftBearingFit',
            'clearanceHoleSize',
            'threadEngagement',
        ],
    },

    'injection-mold': {
        label: 'Injection Mold',
        minWallMm: 1.0,
        requireDraftDeg: 0.5,
        wallThicknessUniformity: 0.20,  // ±20%
        // Plastic shrinkage + warpage makes a slide fit unreliable;
        // moulded bores are typically designed for a transition fit
        // (H7/k6) with a metal insert / overmoulded race. Keep the
        // multiplier looser to account for kerf/shrinkage uncertainty.
        bearingFitDefaults: {
            class: 'H7/k6',
            warningMultiplier: 1.5,
            errorMultiplier: 5.0,
        },
        threadEngagementMultiplier: {
            steel:    1.0,
            aluminum: 1.5,
            plastic:  2.0,
        },
        enabledChecks: [
            'manifoldness',
            'selfIntersection',
            'zeroThickness',
            'holePatternValidity',
            'bearingBoreFit',
            'shaftBearingFit',
            'clearanceHoleSize',
            'threadEngagement',
        ],
    },
};

export const DEFAULT_PROFILE_ID = '3d-print';

/** Resolve a profile id → profile object (falls back to default). */
export function getProfile(id) {
    return PROFILES[id] || PROFILES[DEFAULT_PROFILE_ID];
}

/** Lightweight list-for-UI. */
export function listProfiles() {
    return Object.entries(PROFILES).map(([id, p]) => ({ id, label: p.label }));
}
