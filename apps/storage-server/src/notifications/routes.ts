/**
 * Settings > Notifications, mounted after requireUser:
 *
 *   GET    /notifications/settings        settings, set-up channels, events, secret info
 *   PUT    /notifications/settings        change settings (a whole or partial object)
 *   PUT    /notifications/secrets/:name   save a secret ({ value }); never echoed back
 *   DELETE /notifications/secrets/:name
 *   POST   /notifications/test/:channel   send one test message now
 *
 * Every answer without a service (it could not start) is 503 notifications_off.
 */
import express, { Router } from 'express';
import { ApiError, asyncHandler } from '../api/errors';
import { SendError } from './channels';
import type { NotificationService } from './service';
import { SettingsError } from './settings';
import { isNotificationSecretName } from './secrets';

export function createNotificationsRouter(service: NotificationService | null): Router {
  const router = express.Router();
  const svc = (): NotificationService => {
    if (!service)
      throw new ApiError(503, 'notifications_off', 'Notifications are off on the server');
    return service;
  };

  router.get('/notifications/settings', (_req, res) => {
    res.json(svc().view());
  });

  router.put('/notifications/settings', (req, res) => {
    const s = svc();
    const body = req.body as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'bad_request', 'Send an object of settings');
    }
    try {
      s.updateSettings(body);
    } catch (err) {
      if (err instanceof SettingsError) throw new ApiError(400, 'bad_setting', err.message);
      throw err;
    }
    res.json(s.view());
  });

  router.put('/notifications/secrets/:name', (req, res) => {
    const s = svc();
    const name = req.params.name;
    if (!isNotificationSecretName(name)) throw new ApiError(404, 'not_found', 'No such secret');
    try {
      s.putSecret(name, (req.body as { value?: unknown } | undefined)?.value);
    } catch (err) {
      if (err instanceof SendError) throw new ApiError(400, 'bad_secret', err.message);
      throw new ApiError(400, 'bad_secret', (err as Error).message);
    }
    // Never echoes the value back.
    res.json(s.view());
  });

  router.delete('/notifications/secrets/:name', (req, res) => {
    const s = svc();
    const name = req.params.name;
    if (!isNotificationSecretName(name)) throw new ApiError(404, 'not_found', 'No such secret');
    s.removeSecret(name);
    res.json(s.view());
  });

  router.post(
    '/notifications/test/:channel',
    asyncHandler(async (req, res) => {
      const s = svc();
      const channel = req.params.channel;
      if (channel !== 'discord' && channel !== 'email') {
        throw new ApiError(404, 'not_found', 'No such channel');
      }
      res.json(await s.test(channel));
    }),
  );

  return router;
}
