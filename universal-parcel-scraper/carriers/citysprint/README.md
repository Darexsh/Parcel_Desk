# CitySprint

CitySprint parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

CitySprint's tracker asks for a job number and the sender's account number, or opens from a
link with its own tracking string. Customers of retailers it delivers for, such as Wickes,
quote an eight-digit tracking number, the length of the job numbers in lookups archived
from CitySprint's former tracker. Eight digits are shared by many carriers, so no rule
claims it.

## Links

The tracker's script reads the job number from the first of two path segments after
`tracking.citysprint.co.uk/tracking/`; the second is the account number, which is not read.
A single segment there is a tracking string from CitySprint's messages, not a number, so it
is not read either. Lookups archived from the former tracker put the job number in `job` on
`citysprint.co.uk/track`. No address opens a parcel from the number alone.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
