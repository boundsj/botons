// Imported first by entry points, before any module reads process.env: a setting given under a deprecated name is
// read under its BOTONS_* or BOTON_* name from then on (see shared/legacy-names.mjs).
import { applyLegacyEnv } from '../../shared/legacy-names.mjs';

export const startupEnvNotices = applyLegacyEnv(process.env);
