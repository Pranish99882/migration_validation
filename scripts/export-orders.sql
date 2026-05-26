-- Reference query for the orders loaded by the app (date range comes from .env)

SELECT OrderID, OrderDate
FROM mf_user.Orders
WHERE OrderDate >= '2013-01-01 00:00:00'
  AND OrderDate <= '2013-01-31 23:59:59'
ORDER BY OrderDate ASC, OrderID ASC;
