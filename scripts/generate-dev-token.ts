import 'dotenv/config';
import jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const subject = process.argv[2] ?? 'invoice-service';
const scope = process.argv[3] ?? 'capacity:read capacity:write';

const token = jwt.sign({ scope }, secret, {
  subject,
  expiresIn: '8h',
});

console.log(token);
