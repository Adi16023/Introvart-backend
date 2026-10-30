import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { json, prisma, transaction } from "../lib/db";
import { notFound, uid } from "../lib/http";

const addressSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  name: z.string(),
  phone: z.string(),
  line: z.string(),
  city: z.string(),
  state: z.string(),
  pincode: z.string(),
  label: z.string(),
  createdAt: z.string(),
});

export type CustomerAddress = z.infer<typeof addressSchema>;
export type AddressFields = Omit<CustomerAddress, "id" | "customerId" | "createdAt">;

function parseAddresses(value: Prisma.JsonValue) {
  const parsed = z.array(addressSchema).safeParse(value);
  if (!parsed.success) throw new Error("Stored customer addresses have an invalid format");
  return parsed.data;
}

export async function listCustomerAddresses(customerId: string) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { addresses: true } });
  if (!customer) throw notFound("Customer not found");
  return parseAddresses(customer.addresses).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function updateCustomerAddresses<T>(
  customerId: string,
  update: (addresses: CustomerAddress[]) => { addresses: CustomerAddress[]; result: T },
) {
  return transaction(async (tx) => {
    const [customer] = await tx.$queryRaw<{ addresses: Prisma.JsonValue }[]>`
      SELECT "addresses" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE
    `;
    if (!customer) throw notFound("Customer not found");
    const { addresses, result } = update(parseAddresses(customer.addresses));
    await tx.customer.update({ where: { id: customerId }, data: { addresses: json(addresses) } });
    return result;
  });
}

export function addCustomerAddress(customerId: string, fields: AddressFields) {
  return updateCustomerAddresses(customerId, (addresses) => {
    const address = {
      ...fields,
      id: uid("AD"),
      customerId,
      createdAt: new Date().toISOString(),
    };
    return { addresses: [address, ...addresses], result: address };
  });
}

export function patchCustomerAddress(customerId: string, id: string, fields: Partial<AddressFields>) {
  return updateCustomerAddresses(customerId, (addresses) => {
    const index = addresses.findIndex((address) => address.id === id);
    if (index < 0) throw notFound("Address not found");
    const address = { ...addresses[index], ...fields };
    const updated = [...addresses];
    updated[index] = address;
    return { addresses: updated, result: address };
  });
}

export function deleteCustomerAddress(customerId: string, id: string) {
  return updateCustomerAddresses(customerId, (addresses) => {
    const remaining = addresses.filter((address) => address.id !== id);
    if (remaining.length === addresses.length) throw notFound("Address not found");
    return { addresses: remaining, result: undefined };
  });
}

export function saveCustomerAddressIfMissing(customerId: string, fields: AddressFields) {
  return updateCustomerAddresses(customerId, (addresses) => {
    const exists = addresses.some((address) => address.line === fields.line && address.pincode === fields.pincode);
    if (exists) return { addresses, result: false };
    const address = {
      ...fields,
      id: uid("AD"),
      customerId,
      createdAt: new Date().toISOString(),
    };
    return { addresses: [address, ...addresses], result: true };
  });
}
