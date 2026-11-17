import { ReleaseExpiredCreditReservationsJob } from './release-expired-credit-reservations.job';

describe('ReleaseExpiredCreditReservationsJob', () => {
  it('ejecuta una pasada de liberación', async () => {
    const releaseExpired = {
      execute: jest
        .fn()
        .mockResolvedValue({ expired: 1, orphaned: 0, consumed: 0, failed: 0 }),
    };

    await new ReleaseExpiredCreditReservationsJob(
      releaseExpired as never,
    ).run();

    expect(releaseExpired.execute).toHaveBeenCalledTimes(1);
  });

  /** Un error no puede tumbar el scheduler: la siguiente pasada lo reintenta. */
  it('registra el error y no lo propaga', async () => {
    const releaseExpired = {
      execute: jest.fn().mockRejectedValue(new Error('base caída')),
    };

    await expect(
      new ReleaseExpiredCreditReservationsJob(releaseExpired as never).run(),
    ).resolves.toBeUndefined();
  });
});
