import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Kafka, Partitioners } from 'kafkajs';

const TOPIC = 'treasury.program-reconciliation.v1';

async function main() {
  const [
    programExternalRef = 'PROGRAM-ABC',
    totalLimitMinor = '1100000000',
    currency = 'USD',
    currencyExponent = '2',
    treasuryVersion = String(Date.now()),
    activeReservationsJson = JSON.stringify([
      { invoiceId: 'inv-2', reservedAmountMinor: 500000000, currency: 'USD' },
      { invoiceId: 'inv-3', reservedAmountMinor: 300000000, currency: 'USD' },
    ]),
  ] = process.argv.slice(2);

  const activeReservations = JSON.parse(activeReservationsJson) as Array<{
    invoiceId: string;
    reservedAmountMinor: number;
    currency: string;
  }>;
  const reservedAmountMinor = activeReservations.reduce(
    (sum, item) => sum + item.reservedAmountMinor,
    0,
  );

  const message = {
    messageId: randomUUID(),
    type: 'PROGRAM_RECONCILIATION',
    programExternalRef,
    treasuryVersion: Number(treasuryVersion),
    occurredAt: new Date().toISOString(),
    payload: {
      currency,
      currencyExponent: Number(currencyExponent),
      totalLimitMinor: Number(totalLimitMinor),
      reservedAmountMinor,
      activeReservations,
    },
  };

  const kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID ?? 'capacity-service-producer',
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  });
  const producer = kafka.producer({
    createPartitioner: Partitioners.LegacyPartitioner,
  });
  await producer.connect();
  try {
    await producer.send({
      topic: TOPIC,
      messages: [{ key: programExternalRef, value: JSON.stringify(message) }],
    });
    console.log(
      'Sent PROGRAM_RECONCILIATION:',
      JSON.stringify(message, null, 2),
    );
  } finally {
    await producer.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Failed to produce message:', error);
  process.exit(1);
});
