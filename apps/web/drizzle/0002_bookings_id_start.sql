-- Booking ids are also the on-chain EstelaEscrow ids. Ids below 1000 are left for
-- manual smoke tests on testnet (booking 1 already exists there).
ALTER SEQUENCE "bookings_id_seq" RESTART WITH 1000;
