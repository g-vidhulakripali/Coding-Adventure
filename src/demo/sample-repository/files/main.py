from pricing import calculate_total

prices = [12.0, 8.0, 5.0]
discount = 0.10

subtotal = sum(prices)

total = calculate_total(subtotal, discount)

print(total)
