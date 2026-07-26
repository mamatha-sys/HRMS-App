import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { getRolePermissionMap, isSuperAdmin } from '../utils/rbac.js';

// Every authenticated role (not just Super Admin) needs to know its own real permissions so
// the client can render the Sidebar dynamically — this is intentionally NOT gated by
// requireRole('super_admin') like the rest of roles.routes.js.
const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({
    role: req.user.role,
    isSuperAdmin: isSuperAdmin(req.user.role),
    modules: getRolePermissionMap(req.user.role)
  });
});

export default router;
