import { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HttpExceptionFilter } from './http-exception.filter';

function buildHost(): {
  host: ArgumentsHost;
  json: jest.Mock;
  status: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;
  return { host, json, status };
}

function prismaUniqueViolation(
  target: string[],
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

describe('HttpExceptionFilter Prisma error mapping', () => {
  it('maps a unique violation on invoiceId to INVOICE_ALREADY_RESERVED', () => {
    const filter = new HttpExceptionFilter();
    const { host, json, status } = buildHost();

    filter.catch(prismaUniqueViolation(['programId', 'invoiceId']), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVOICE_ALREADY_RESERVED' }),
    );
  });

  it('maps a unique violation on externalMessageId to TREASURY_MESSAGE_ALREADY_PROCESSED', () => {
    const filter = new HttpExceptionFilter();
    const { host, json, status } = buildHost();

    filter.catch(prismaUniqueViolation(['externalMessageId']), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'TREASURY_MESSAGE_ALREADY_PROCESSED' }),
    );
  });

  it('falls back to a generic 500 for unmapped unique violations', () => {
    const filter = new HttpExceptionFilter();
    const { host, json, status } = buildHost();

    filter.catch(prismaUniqueViolation(['someOtherColumn']), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INTERNAL_ERROR' }),
    );
  });
});
